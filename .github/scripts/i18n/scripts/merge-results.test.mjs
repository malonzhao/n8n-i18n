import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { buildOrderedWithExtras, main, mergeLocale } from './merge-results.mjs';

/** Returns the entry id of a top-level key. */
const id = (key) => JSON.stringify([key]);

/** Creates translation and state maps from plain objects of top-level keys. */
function maps(translations, state) {
	return {
		translations: new Map(Object.entries(translations).map(([key, value]) => [id(key), value])),
		state: new Map(Object.entries(state).map(([key, value]) => [id(key), value])),
	};
}

describe('mergeLocale', () => {
	it('takes the result where master did not change, and keeps master where it changed', () => {
		const base = maps(
			{ a: 'A0', b: 'B0', c: 'C0', d: 'D0' },
			{ a: 'ha', b: 'hb', c: 'hc', d: 'hd' },
		);
		const master = maps(
			{ a: 'A-manual', b: 'B0', d: 'D0', e: 'E-manual' },
			{ a: 'ha', b: 'hb', d: 'hd' },
		);
		const result = maps(
			{ a: 'A1', b: 'B1', c: 'C1', f: 'F1' },
			{ a: 'ha2', b: 'hb2', c: 'hc2', f: 'hf' },
		);
		const merged = mergeLocale({ master, base, result });
		assert.deepEqual(Object.fromEntries(merged.translations), {
			[id('a')]: 'A-manual',
			[id('b')]: 'B1',
			[id('e')]: 'E-manual',
			[id('f')]: 'F1',
		});
		assert.deepEqual(Object.fromEntries(merged.state), {
			[id('a')]: 'ha',
			[id('b')]: 'hb2',
			[id('f')]: 'hf',
		});
		assert.equal(merged.keptFromMaster, 3);
	});

	it('applies deletions from the result when master did not change the entry', () => {
		const base = maps({ gone: 'G' }, { gone: 'hg' });
		const merged = mergeLocale({ master: base, base, result: maps({}, {}) });
		assert.equal(merged.translations.size, 0);
		assert.equal(merged.state.size, 0);
		assert.equal(merged.keptFromMaster, 0);
	});

	it('keeps an entry that master changed only in its state', () => {
		const base = maps({ a: 'A' }, { a: 'h1' });
		const master = maps({ a: 'A' }, { a: 'h2' });
		const result = maps({ a: 'A-new' }, { a: 'h3' });
		const merged = mergeLocale({ master, base, result });
		assert.equal(merged.translations.get(id('a')), 'A');
		assert.equal(merged.state.get(id('a')), 'h2');
	});
});

describe('buildOrderedWithExtras', () => {
	it('uses the source order and appends entries that the source does not have', () => {
		const source = { b: 'B', nested: { x: 'X' }, a: 'A' };
		const values = new Map([
			[id('a'), '1'],
			[JSON.stringify(['nested', 'x']), '2'],
			[id('extra'), '3'],
			[id('b'), '4'],
		]);
		const result = buildOrderedWithExtras(source, values);
		assert.deepEqual(result, { b: '4', nested: { x: '2' }, a: '1', extra: '3' });
		assert.deepEqual(Object.keys(result), ['b', 'nested', 'a', 'extra']);
	});
});

describe('main', () => {
	let dir;
	let i18nDir;
	let resultsDir;
	let source;

	/** Writes a JSON file and creates its directory. */
	function write(path, value) {
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, JSON.stringify(value));
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'i18n-merge-test-'));
		i18nDir = join(dir, 'i18n');
		resultsDir = join(dir, 'results');
		source = join(dir, 'en.json');
		writeFileSync(source, '{\n\t"a": "A",\n\t"nested": {\n\t\t"b": "B"\n\t},\n\t"c": "C"\n}\n');
		write(join(i18nDir, 'config.json'), {
			locales: [
				{ code: 'de', name: 'German' },
				{ code: 'fr', name: 'French' },
				{ code: 'ja', name: 'Japanese' },
			],
			batchSize: 1,
			maxBatchChars: 1,
			concurrency: 1,
			maxAttempts: 1,
		});
		write(join(i18nDir, 'locales', 'de.json'), { a: 'A-manual', c: 'C0' });
		write(join(i18nDir, 'state', 'de.json'), { a: 'ha', c: 'hc' });
		write(join(i18nDir, 'locales', 'ja.json'), { a: 'ア' });
		write(join(resultsDir, 'base', 'locales', 'de.json'), { a: 'A0', c: 'C0' });
		write(join(resultsDir, 'base', 'state', 'de.json'), { a: 'ha', c: 'hc' });
		write(join(resultsDir, 'locales', 'de.json'), { c: 'C1', a: 'A1', nested: { b: 'B1' } });
		write(join(resultsDir, 'state', 'de.json'), { a: 'ha', c: 'hc2', nested: { b: 'hb' } });
		write(join(resultsDir, 'locales', 'fr.json'), { a: 'A-fr' });
		write(join(resultsDir, 'state', 'fr.json'), { a: 'ha' });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('merges every locale with results and skips the others', () => {
		const logs = [];
		const code = main(['--source', source, '--results-dir', resultsDir, '--i18n-dir', i18nDir], {
			log: (message) => logs.push(message),
		});
		assert.equal(code, 0, logs.join('\n'));
		const de = readFileSync(join(i18nDir, 'locales', 'de.json'), 'utf8');
		assert.equal(de, '{\n\t"a": "A-manual",\n\t"nested": {\n\t\t"b": "B1"\n\t},\n\t"c": "C1"\n}\n');
		assert.deepEqual(JSON.parse(readFileSync(join(i18nDir, 'state', 'de.json'), 'utf8')), {
			a: 'ha',
			nested: { b: 'hb' },
			c: 'hc2',
		});
		assert.deepEqual(JSON.parse(readFileSync(join(i18nDir, 'locales', 'fr.json'), 'utf8')), {
			a: 'A-fr',
		});
		assert.equal(readFileSync(join(i18nDir, 'locales', 'ja.json'), 'utf8'), '{"a":"ア"}');
		assert.equal(existsSync(join(i18nDir, 'state', 'ja.json')), false);
		assert.ok(logs.includes('ja: no results, skipped.'));
		assert.ok(logs.includes('de: 3 translations, 1 entries kept from master.'));
	});

	it('returns the usage code for bad arguments and input files', () => {
		const log = () => {};
		assert.equal(main(['--source', source], { log }), 2);
		assert.equal(
			main(
				['--source', join(dir, 'missing.json'), '--results-dir', resultsDir, '--i18n-dir', i18nDir],
				{
					log,
				},
			),
			2,
		);
		writeFileSync(join(resultsDir, 'locales', 'de.json'), '{ broken');
		assert.equal(
			main(['--source', source, '--results-dir', resultsDir, '--i18n-dir', i18nDir], { log }),
			2,
		);
	});
});
