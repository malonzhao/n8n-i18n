import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
	DESIGN_SYSTEM_KEY,
	TEMPLATES,
	buildSource,
	convertDesignSystemMessages,
	loadDesignSystemMessages,
	main,
	renderTemplate,
} from './build-source.mjs';
import { UsageError } from './translate.mjs';

/** Path of the script under test. */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'build-source.mjs');

/** Design system message module with type annotations, in the form of the upstream file. */
const DESIGN_SYSTEM_TS = `import type { N8nLocale } from '../../types';

export default {
	'plain.text': 'Plain {name}',
	'plain.noArgs': () => 'No arguments',
	'formInput.validator.oneNumbersRequired': (config: { minimum: number }) => {
		return \`Must have at least \${config.minimum} number\${config.minimum > 1 ? 's' : ''}\`;
	},
	'formInput.validator.uppercaseCharsRequired': (config: { minimum: number }) =>
		\`Needs \${config.minimum} capital letters\`,
	'tags.showMore': (count: number) => \`+\${count} more\`,
	'plain.unknown': (value: string) => \`Value \${value}\`,
} as N8nLocale;
`;

/** Editor messages of the fixture, with the tab indentation of the upstream file. */
const EN_JSON = '{\n\t"a": "A",\n\t"_reusableBaseText": {\n\t\t"b": "B"\n\t}\n}\n';

describe('renderTemplate', () => {
	it('replaces named and list placeholders and keeps unknown ones', () => {
		assert.equal(
			renderTemplate('At least {minimum} of {other}', { minimum: 2 }),
			'At least 2 of {other}',
		);
		assert.equal(renderTemplate('+{0} more', [5]), '+5 more');
	});
});

describe('convertDesignSystemMessages', () => {
	/** Templates of the unit tests. */
	const templates = {
		'same.object': { template: 'At least {minimum} items', sample: { minimum: 2 } },
		'same.list': { template: '+{0} of {1}', sample: [1, 3] },
		changed: { template: 'Old {minimum}', sample: { minimum: 2 } },
	};

	it('keeps strings, calls functions without parameters, and uses matching templates', () => {
		const { converted, warnings } = convertDesignSystemMessages(
			{
				text: 'Text {count}',
				noArgs: () => 'From a function',
				'same.object': (config) => `At least ${config.minimum} items`,
				'same.list': (first, second) => `+${first} of ${second}`,
			},
			templates,
		);
		assert.deepEqual(converted, {
			text: 'Text {count}',
			noArgs: 'From a function',
			'same.object': 'At least {minimum} items',
			'same.list': '+{0} of {1}',
		});
		assert.deepEqual(warnings, []);
	});

	it('skips functions that do not match their template, have unknown parameters, fail, or return no string', () => {
		const { converted, warnings } = convertDesignSystemMessages(
			{
				changed: (config) => `New ${config.minimum}`,
				unknown: (value) => `Value ${value}`,
				failing: () => {
					throw new Error('boom');
				},
				number: () => 3,
				other: 3,
				defaulted: (count = 1) => `${count} items`,
				rest: (...values) => `Value ${values[0]}`,
			},
			templates,
		);
		assert.deepEqual(converted, {});
		assert.equal(warnings.length, 7);
		assert.match(warnings[0], /"changed".*returns "New 2".*gives "Old 2"/);
		assert.match(warnings[1], /"unknown".*parameters and has no template/);
		assert.match(warnings[2], /"failing".*boom/);
		assert.match(warnings[3], /"number".*does not return a string/);
		assert.match(warnings[4], /"other".*not a string or a function/);
		assert.match(warnings[5], /"defaulted".*uses its arguments and has no template/);
		assert.match(warnings[6], /"rest".*uses its arguments and has no template/);
	});

	it('keeps a string that has a template', () => {
		const { converted, warnings } = convertDesignSystemMessages(
			{ 'same.object': 'At least {minimum} entries' },
			templates,
		);
		assert.deepEqual(converted, { 'same.object': 'At least {minimum} entries' });
		assert.deepEqual(warnings, []);
	});
});

describe('buildSource', () => {
	it('adds the design system messages after the editor messages', () => {
		const { messages, warnings, count } = buildSource({ a: 'A', b: { c: 'C' } }, { x: 'X' });
		assert.deepEqual(Object.keys(messages), ['a', 'b', DESIGN_SYSTEM_KEY]);
		assert.deepEqual(messages[DESIGN_SYSTEM_KEY], { x: 'X' });
		assert.deepEqual(warnings, []);
		assert.equal(count, 1);
	});

	it('fails when the editor messages already have the design system key', () => {
		assert.throws(
			() => buildSource({ [DESIGN_SYSTEM_KEY]: {} }, { x: 'X' }),
			(error) => error instanceof UsageError && /already have the key/.test(error.message),
		);
	});

	it('fails when no design system message is a string', () => {
		assert.throws(() => buildSource({ a: 'A' }, { x: (value) => value }), /no string entries/);
		assert.throws(() => buildSource({ a: 'A' }, {}), UsageError);
	});
});

describe('build-source command', () => {
	let dir;
	let messagesPath;
	let designSystemPath;
	let outputPath;
	let logs;
	const log = (message) => logs.push(message);

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'i18n-build-source-test-'));
		messagesPath = join(dir, 'en.json');
		designSystemPath = join(dir, 'en.ts');
		outputPath = join(dir, 'out', 'en.json');
		writeFileSync(messagesPath, EN_JSON);
		writeFileSync(designSystemPath, DESIGN_SYSTEM_TS);
		logs = [];
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** Returns the arguments that run the command on the fixture files. */
	const args = () => [
		'--messages',
		messagesPath,
		'--design-system',
		designSystemPath,
		'--output',
		outputPath,
	];

	it('writes the editor messages and the converted design system messages', async () => {
		assert.equal(await main(args(), { log }), 0);
		const text = readFileSync(outputPath, 'utf8');
		assert.ok(text.startsWith('{\n\t"a": "A",'));
		assert.deepEqual(JSON.parse(text), {
			a: 'A',
			_reusableBaseText: { b: 'B' },
			[DESIGN_SYSTEM_KEY]: {
				'plain.text': 'Plain {name}',
				'plain.noArgs': 'No arguments',
				'formInput.validator.oneNumbersRequired':
					TEMPLATES['formInput.validator.oneNumbersRequired'].template,
				'tags.showMore': TEMPLATES['tags.showMore'].template,
			},
		});
		const warnings = logs.filter((message) => message.startsWith('::warning::'));
		assert.equal(warnings.length, 2);
		assert.match(warnings[0], /uppercaseCharsRequired/);
		assert.match(warnings[1], /plain\.unknown/);
		assert.match(logs.at(-1), /4 design system messages \(2 skipped\)/);
	});

	it('fails when the editor messages already have the design system key', async () => {
		writeFileSync(messagesPath, JSON.stringify({ a: 'A', [DESIGN_SYSTEM_KEY]: { x: 'X' } }));
		assert.equal(await main(args(), { log }), 2);
		assert.match(logs[0], /^::error::.*already have the key/);
		assert.equal(existsSync(outputPath), false);
	});

	it('fails when an input file is missing or not valid', async () => {
		assert.equal(await main([], { log }), 2);
		assert.match(logs.at(-1), /^::error::Usage/);

		rmSync(messagesPath);
		assert.equal(await main(args(), { log }), 2);
		assert.match(logs.at(-1), /^::error::Cannot read the messages file/);

		writeFileSync(messagesPath, '["not", "an", "object"]');
		assert.equal(await main(args(), { log }), 2);
		assert.match(logs.at(-1), /^::error::.*is not a JSON object/);

		writeFileSync(messagesPath, EN_JSON);
		rmSync(designSystemPath);
		assert.equal(await main(args(), { log }), 2);
		assert.match(logs.at(-1), /^::error::Cannot import the design system messages/);
		assert.equal(existsSync(outputPath), false);
	});

	it('fails when the design system module has no plain object as default export', async () => {
		const path = join(dir, 'no-default.ts');
		writeFileSync(path, "export const a: string = 'A';\n");
		await assert.rejects(loadDesignSystemMessages(path), /is not a plain object/);
	});

	it('runs as a command line program', () => {
		const ok = spawnSync(process.execPath, [SCRIPT, ...args()], { encoding: 'utf8' });
		assert.equal(ok.status, 0, ok.stderr);
		assert.match(ok.stdout, /Wrote .* with 4 design system messages/);
		assert.ok(existsSync(outputPath));

		const failed = spawnSync(process.execPath, [SCRIPT, '--messages', messagesPath], {
			encoding: 'utf8',
		});
		assert.equal(failed.status, 2);
		assert.match(failed.stdout, /::error::Usage/);
	});
});
