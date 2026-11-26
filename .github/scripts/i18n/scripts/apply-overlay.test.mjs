import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
	LOADER_IMPORT,
	OverlayError,
	applyOverlay,
	loadMessageCompiler,
	main,
	removeUncompilable,
} from './apply-overlay.mjs';

/** Path of the script under test. */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'apply-overlay.mjs');

/** Root of the repository that contains this script, which may have the real compiler installed. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Real vue-i18n message compiler, or null when the repository has no installed dependencies. */
const realCompile = (() => {
	try {
		return loadMessageCompiler(REPO_ROOT);
	} catch {
		return null;
	}
})();

/** Fake compiler that accepts every message. */
const acceptAll = () => null;

/** Fake compiler that rejects messages that contain "BAD". */
const rejectBad = (message) => (message.includes('BAD') ? 'bad message' : null);

/** Original content of the fixture entry point. */
const MAIN_TS = "import { createApp } from 'vue';\n\ncreateApp({}).mount('#app');\n";

describe('applyOverlay', () => {
	let dir;
	let repoRoot;
	let i18nDir;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'i18n-overlay-test-'));
		repoRoot = join(dir, 'repo');
		i18nDir = join(dir, 'i18n');
		mkdirSync(join(repoRoot, 'packages/frontend/@n8n/i18n/src/locales'), { recursive: true });
		mkdirSync(join(repoRoot, 'packages/frontend/editor-ui/src/app'), { recursive: true });
		writeFileSync(join(repoRoot, 'packages/frontend/@n8n/i18n/src/locales/en.json'), '{"a":"A"}\n');
		writeFileSync(join(repoRoot, 'packages/frontend/editor-ui/src/main.ts'), MAIN_TS);
		mkdirSync(join(i18nDir, 'locales'), { recursive: true });
		mkdirSync(join(i18nDir, 'overlay'), { recursive: true });
		writeFileSync(
			join(i18nDir, 'config.json'),
			JSON.stringify({
				locales: [
					{ code: 'zh-CN' },
					{ code: 'ja' },
					{ code: 'de' },
					{ code: 'fr' },
					{ code: 'en' },
				],
			}),
		);
		writeFileSync(join(i18nDir, 'locales', 'zh-CN.json'), '{\n\t"a": "甲"\n}\n');
		writeFileSync(join(i18nDir, 'locales', 'ja.json'), '{ broken');
		writeFileSync(join(i18nDir, 'locales', 'de.json'), '["not", "an", "object"]');
		writeFileSync(join(i18nDir, 'locales', 'en.json'), '{"a":"overwritten"}');
		writeFileSync(join(i18nDir, 'locales', 'ko.json'), '{"a":"not listed"}');
		writeFileSync(join(i18nDir, 'overlay', 'i18nLocaleLoader.ts'), 'export {};\n');
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const localesDir = () => join(repoRoot, 'packages/frontend/editor-ui/src/app/i18nLocales');
	const upstreamLocalesDir = () => join(repoRoot, 'packages/frontend/@n8n/i18n/src/locales');
	const mainPath = () => join(repoRoot, 'packages/frontend/editor-ui/src/main.ts');

	it('copies valid listed locales, installs the loader, and appends the import', () => {
		const logs = [];
		const result = applyOverlay({
			repoRoot,
			i18nDir,
			log: (message) => logs.push(message),
			loadCompiler: () => acceptAll,
		});
		assert.deepEqual(result.copied, ['zh-CN']);
		assert.equal(result.compileChecked, true);
		assert.deepEqual(result.removedByLocale, { 'zh-CN': [] });
		assert.deepEqual(result.skipped, ['ja', 'de', 'fr']);
		assert.equal(result.importAdded, true);
		assert.equal(readFileSync(join(localesDir(), 'zh-CN.json'), 'utf8'), '{\n\t"a": "甲"\n}\n');
		assert.equal(existsSync(join(localesDir(), 'ja.json')), false);
		assert.equal(existsSync(join(localesDir(), 'de.json')), false);
		assert.equal(existsSync(join(localesDir(), 'ko.json')), false);
		assert.equal(existsSync(join(localesDir(), 'en.json')), false);
		assert.equal(readFileSync(join(upstreamLocalesDir(), 'en.json'), 'utf8'), '{"a":"A"}\n');
		assert.equal(existsSync(join(upstreamLocalesDir(), 'zh-CN.json')), false);
		assert.equal(
			readFileSync(
				join(repoRoot, 'packages/frontend/editor-ui/src/app/i18nLocaleLoader.ts'),
				'utf8',
			),
			'export {};\n',
		);
		assert.equal(readFileSync(mainPath(), 'utf8'), `${MAIN_TS}${LOADER_IMPORT}\n`);
		assert.equal(logs.filter((line) => line.startsWith('::warning::')).length, 2);
	});

	it('removes entries that the compiler rejects and keeps the others', () => {
		writeFileSync(
			join(i18nDir, 'locales', 'zh-CN.json'),
			'{\n  "a": "好",\n  "b": "BAD one",\n  "_reusable": {\n    "c": "BAD two",\n    "d": "丁"\n  },\n  "e": {\n    "f": "BAD three"\n  }\n}\n',
		);
		const logs = [];
		const result = applyOverlay({
			repoRoot,
			i18nDir,
			log: (message) => logs.push(message),
			loadCompiler: () => rejectBad,
		});
		assert.deepEqual(result.removedByLocale['zh-CN'], ['b', '_reusable.c', 'e.f']);
		assert.equal(
			readFileSync(join(localesDir(), 'zh-CN.json'), 'utf8'),
			'{\n  "a": "好",\n  "_reusable": {\n    "d": "丁"\n  }\n}\n',
		);
		const warning = logs.find((line) => line.includes('Removed 3 entries from zh-CN'));
		assert.ok(warning?.startsWith('::warning::'));
		assert.match(warning, /b \(bad message\); _reusable\.c \(bad message\); e\.f \(bad message\)/);
	});

	it('copies the files without a check when the compiler is not available', () => {
		writeFileSync(join(i18nDir, 'locales', 'zh-CN.json'), '{"a": "BAD"}');
		const logs = [];
		const result = applyOverlay({
			repoRoot,
			i18nDir,
			log: (message) => logs.push(message),
			loadCompiler: () => {
				throw new Error('Cannot find module vue-i18n');
			},
		});
		assert.equal(result.compileChecked, false);
		assert.deepEqual(result.copied, ['zh-CN']);
		assert.equal(readFileSync(join(localesDir(), 'zh-CN.json'), 'utf8'), '{"a": "BAD"}');
		assert.ok(
			logs.some(
				(line) =>
					line.startsWith('::warning::The vue-i18n message compiler is not available') &&
					line.includes('Cannot find module vue-i18n'),
			),
		);
	});

	it(
		'removes messages that the real vue-i18n compiler rejects',
		{ skip: realCompile === null },
		() => {
			writeFileSync(
				join(i18nDir, 'locales', 'zh-CN.json'),
				JSON.stringify({
					braces: '<code>{{ }}</code>',
					email: 'mail a@b.com',
					literal: "{'{{x}}'} ok",
					link: '@:_reusableBaseText.cancel',
					placeholder: '你好 {name}',
					plural: '一项 | {count} 项',
				}),
			);
			const result = applyOverlay({ repoRoot, i18nDir, loadCompiler: () => realCompile });
			assert.deepEqual(result.removedByLocale['zh-CN'], ['braces', 'email']);
			assert.deepEqual(
				Object.keys(JSON.parse(readFileSync(join(localesDir(), 'zh-CN.json'), 'utf8'))),
				['literal', 'link', 'placeholder', 'plural'],
			);
		},
	);

	it('is idempotent', () => {
		applyOverlay({ repoRoot, i18nDir });
		const second = applyOverlay({ repoRoot, i18nDir });
		assert.equal(second.importAdded, false);
		const content = readFileSync(mainPath(), 'utf8');
		assert.equal(content.split(LOADER_IMPORT).length - 1, 1);
		assert.equal(content, `${MAIN_TS}${LOADER_IMPORT}\n`);
	});

	it('adds a line break when the entry point does not end with one', () => {
		writeFileSync(mainPath(), 'const a = 1;');
		applyOverlay({ repoRoot, i18nDir });
		assert.equal(readFileSync(mainPath(), 'utf8'), `const a = 1;\n${LOADER_IMPORT}\n`);
	});

	it('installs the loader when there are no locale files', () => {
		rmSync(join(i18nDir, 'locales'), { recursive: true });
		const result = applyOverlay({ repoRoot, i18nDir });
		assert.deepEqual(result.copied, []);
		assert.ok(
			existsSync(join(repoRoot, 'packages/frontend/editor-ui/src/app/i18nLocaleLoader.ts')),
		);
		assert.ok(readFileSync(mainPath(), 'utf8').includes(LOADER_IMPORT));
	});

	it('fails when a target path does not exist', () => {
		rmSync(mainPath());
		assert.throws(() => applyOverlay({ repoRoot, i18nDir }), OverlayError);
		rmSync(join(repoRoot, 'packages/frontend/editor-ui/src/app'), { recursive: true });
		assert.throws(() => applyOverlay({ repoRoot, i18nDir }), /does not exist/);
		assert.equal(existsSync(localesDir()), false);
	});

	it('returns exit codes from main', () => {
		const logs = [];
		const log = (message) => logs.push(message);
		assert.equal(main([], { log }), 1);
		assert.equal(main(['--repo-root', join(dir, 'missing'), '--i18n-dir', i18nDir], { log }), 1);
		assert.equal(main(['--repo-root', repoRoot, '--i18n-dir', i18nDir], { log }), 0);
		assert.match(logs[0], /^::error::Usage/);
	});

	it('runs as a command line program', () => {
		const ok = spawnSync(
			process.execPath,
			[SCRIPT, '--repo-root', repoRoot, '--i18n-dir', i18nDir],
			{
				encoding: 'utf8',
			},
		);
		assert.equal(ok.status, 0, ok.stderr);
		assert.match(ok.stdout, /Copied locales: zh-CN/);
		const failed = spawnSync(process.execPath, [SCRIPT, '--repo-root', join(dir, 'missing')], {
			encoding: 'utf8',
		});
		assert.equal(failed.status, 1);
		assert.match(failed.stdout, /::error::/);
	});
});

describe('removeUncompilable', () => {
	it('removes rejected strings, values that are not strings, and empty objects', () => {
		const result = removeUncompilable(
			{ a: 'ok', b: 'BAD', c: 3, d: { e: 'BAD' }, f: { g: 'ok' } },
			rejectBad,
		);
		assert.deepEqual(result.kept, { a: 'ok', f: { g: 'ok' } });
		assert.deepEqual(
			result.removed.map((item) => item.key),
			['b', 'c', 'd.e'],
		);
	});
});
