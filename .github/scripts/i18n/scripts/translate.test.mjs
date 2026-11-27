import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
	FatalApiError,
	buildApiRequest,
	buildOrdered,
	classifyEntry,
	createBatches,
	detectIndent,
	flattenMessages,
	hashSource,
	isPassthrough,
	main,
	parseModelOutput,
	parseRetryAfter,
	planTranslation,
	readApiResponse,
	requestBatch,
	splitPluralForms,
	toValueMap,
	tokenize,
	translateLocale,
	validateTranslation,
} from './translate.mjs';

/** Source messages with dotted keys and a nested object, like en.json. */
const SOURCE = {
	'app.title': 'Workflows',
	'app.count': '1 item | {count} items',
	_reusableBaseText: { cancel: 'Cancel', roles: { admin: 'Admin' } },
	'app.cancel': '@:_reusableBaseText.cancel',
	'app.link': 'Read the <a href="https://docs.n8n.io">docs</a>',
};

/** Locale definition used by the tests. */
const LOCALE = { code: 'de', name: 'German', nativeName: 'Deutsch', glossary: {} };

/** Settings used by the tests. */
const SETTINGS = {
	batchSize: 10,
	maxBatchChars: 10_000,
	concurrency: 2,
	maxAttempts: 3,
	requestOptions: {},
	requestTimeoutMs: 1000,
};

/** Reason for a translation that is not in the language of the target locale. */
const OTHER_LANGUAGE =
	'translation is not in the target language: it has no text in the script of the target language and adds words that the source does not have';

/** Locale definition with a script that is not Latin, used by the tests. */
const ARABIC = { code: 'ar', name: 'Arabic', nativeName: 'العربية', glossary: {} };

/** API configuration used by the tests. */
const API = { baseUrl: 'https://llm.example.test/v1/', model: 'test-model', apiKey: 'secret' };

/** Creates a fake response object for a stubbed fetch. */
function response(status, body, headers = {}) {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: { get: (name) => headers[name.toLowerCase()] ?? null },
		json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
		text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
	};
}

/** Creates a chat completion response whose content is the given text. */
function completion(content) {
	return response(200, { choices: [{ message: { content } }] });
}

/** Creates a fetch stub that translates every request with a function of the English text, the key, and the correction state. */
function translatingFetch(transform, calls = []) {
	return async (url, init) => {
		calls.push({ url, init });
		const [request, correction] = JSON.parse(init.body).messages[1].content.split(
			'\n\nAn automatic check',
		);
		const result = Object.fromEntries(
			Object.entries(JSON.parse(request)).map(([key, value]) => [
				key,
				transform(value, key, correction !== undefined),
			]),
		);
		return completion(`\`\`\`json\n${JSON.stringify(result)}\n\`\`\``);
	};
}

/** Creates test dependencies with a fake clock. */
function testDeps(overrides = {}) {
	let clock = 0;
	const sleeps = [];
	const logs = [];
	return {
		sleeps,
		logs,
		deps: {
			now: () => clock,
			sleep: async (ms) => {
				sleeps.push(ms);
				clock += ms;
			},
			random: () => 0,
			log: (message) => logs.push(message),
			...overrides,
		},
	};
}

describe('flattenMessages and buildOrdered', () => {
	it('keeps dotted keys and nested objects apart', () => {
		const entries = flattenMessages(SOURCE);
		assert.deepEqual(
			entries.map((entry) => entry.key),
			[
				'app.title',
				'app.count',
				'_reusableBaseText.cancel',
				'_reusableBaseText.roles.admin',
				'app.cancel',
				'app.link',
			],
		);
		assert.deepEqual(entries[2].path, ['_reusableBaseText', 'cancel']);
		assert.notEqual(entries[0].id, JSON.stringify(['app', 'title']));
	});

	it('rebuilds the source shape and order with only the known values', () => {
		const values = new Map([
			[JSON.stringify(['app.link']), 'L'],
			[JSON.stringify(['_reusableBaseText', 'roles', 'admin']), 'A'],
			[JSON.stringify(['app.title']), 'T'],
		]);
		const result = buildOrdered(SOURCE, values);
		assert.deepEqual(result, {
			'app.title': 'T',
			_reusableBaseText: { roles: { admin: 'A' } },
			'app.link': 'L',
		});
		assert.deepEqual(Object.keys(result), ['app.title', '_reusableBaseText', 'app.link']);
	});

	it('detects the indentation of the source text', () => {
		assert.equal(detectIndent('{\n\t"a": 1\n}'), '\t');
		assert.equal(detectIndent('{\n  "a": 1\n}'), '  ');
	});
});

describe('incremental planning', () => {
	const entries = flattenMessages(SOURCE);
	const title = entries[0];

	it('classifies entries by translation, state record, and validity', () => {
		const translations = new Map([[title.id, 'Arbeitsabläufe']]);
		assert.equal(classifyEntry(title, new Map(), new Map()), 'translate');
		assert.equal(
			classifyEntry(title, translations, new Map([[title.id, hashSource('Old text')]])),
			'translate',
		);
		assert.equal(classifyEntry(title, translations, new Map()), 'adopt');
		assert.equal(classifyEntry(title, new Map([[title.id, 'Kaputt {']]), new Map()), 'translate');
		assert.equal(
			classifyEntry(title, translations, new Map([[title.id, hashSource(title.value)]])),
			'keep',
		);
	});

	it('keeps a valid translation without a state record and records its hash', () => {
		const translations = new Map([
			[title.id, 'Arbeitsabläufe (manuell)'],
			[entries[1].id, 'Ohne Platzhalter'],
		]);
		const plan = planTranslation(entries, translations, new Map());
		assert.equal(plan.adopted, 1);
		assert.equal(plan.translations.get(title.id), 'Arbeitsabläufe (manuell)');
		assert.equal(plan.state.get(title.id), hashSource(title.value));
		assert.equal(plan.translations.has(entries[1].id), false);
		assert.ok(plan.pending.some((entry) => entry.id === entries[1].id));
		assert.ok(!plan.pending.some((entry) => entry.id === title.id));
	});

	it('keeps a stored translation that leaves out an optional placeholder', () => {
		const [entry] = flattenMessages({ versions: '{n} version{suffix}' });
		const translations = new Map([[entry.id, '{n} 个版本']]);
		const state = new Map([[entry.id, hashSource(entry.value)]]);
		assert.equal(planTranslation([entry], translations, state).pending.length, 1);
		assert.equal(planTranslation([entry], translations, state, ['suffix']).pending.length, 0);
	});

	it('translates a stored translation in a different language again only with a locale code', () => {
		const [entry, other] = flattenMessages({ creds: 'Credentials', title: 'Workflows' });
		const translations = new Map([
			[entry.id, 'Credenciales'],
			[other.id, 'سير العمل'],
		]);
		const state = new Map([
			[entry.id, hashSource(entry.value)],
			[other.id, hashSource(other.value)],
		]);
		assert.equal(classifyEntry(entry, translations, state), 'keep');
		assert.equal(classifyEntry(entry, translations, state, [], 'ar'), 'translate');
		assert.equal(classifyEntry(other, translations, state, [], 'ar'), 'keep');
		assert.equal(classifyEntry(entry, translations, new Map(), [], 'ar'), 'translate');
		assert.equal(planTranslation([entry, other], translations, state).pending.length, 0);
		const plan = planTranslation([entry, other], translations, state, [], 'ar');
		assert.deepEqual(
			plan.pending.map((item) => item.key),
			['creds'],
		);
		assert.equal(plan.translations.has(entry.id), false);
		assert.equal(plan.translations.get(other.id), 'سير العمل');
	});

	it('keeps manual edits, drops stale entries, and removes keys that upstream deleted', () => {
		const translations = new Map([
			[title.id, 'Manually edited'],
			[entries[1].id, 'Stale'],
			[JSON.stringify(['gone']), 'Removed'],
		]);
		const state = new Map([
			[title.id, hashSource(title.value)],
			[entries[1].id, hashSource('1 thing | {count} things')],
			[JSON.stringify(['gone']), 'x'],
			[JSON.stringify(['gone.too']), 'y'],
		]);
		const plan = planTranslation(entries, translations, state);
		assert.equal(plan.removed, 2);
		assert.equal(plan.translations.get(title.id), 'Manually edited');
		assert.equal(plan.translations.has(entries[1].id), false);
		assert.equal(plan.state.has(JSON.stringify(['gone'])), false);
		assert.deepEqual(
			plan.pending.map((entry) => entry.key),
			entries.slice(1).map((entry) => entry.key),
		);
	});

	it('tokenizes literals as single tokens', () => {
		const tokens = tokenize("Inside <code>{'{{ }}'}</code> is {x} and @:a.b ok");
		assert.deepEqual(tokens.literals, ["{'{{ }}'}"]);
		assert.deepEqual(tokens.placeholders, ['{x}']);
		assert.deepEqual(tokens.tags, ['<code>', '</code>']);
		assert.deepEqual(tokens.links, ['@:a.b']);
		assert.equal(tokens.bare, 'Inside  is  and  ok');
	});

	it('splits plural forms only at separators outside tokens', () => {
		assert.deepEqual(splitPluralForms('No items'), ['No items']);
		assert.deepEqual(splitPluralForms('1 item | {n} items'), ['1 item ', ' {n} items']);
		assert.deepEqual(splitPluralForms('a {\'|\'} b | <i title="x|y">c</i>'), [
			"a {'|'} b ",
			' <i title="x|y">c</i>',
		]);
	});

	it('treats pure linked messages as text without anything to translate', () => {
		assert.equal(isPassthrough('@:_reusableBaseText.cancel'), true);
		assert.equal(isPassthrough('{count}'), true);
		assert.equal(isPassthrough('Cancel'), false);
	});
});

describe('createBatches', () => {
	const make = (key, value) => ({ id: key, key, value });

	it('limits the entry count and the character count', () => {
		const entries = Array.from({ length: 5 }, (_, i) => make(`k${i}`, 'x'.repeat(8)));
		assert.deepEqual(
			createBatches(entries, { batchSize: 2, maxBatchChars: 1000 }).map((batch) => batch.length),
			[2, 2, 1],
		);
		assert.deepEqual(
			createBatches(entries, { batchSize: 10, maxBatchChars: 25 }).map((batch) => batch.length),
			[2, 2, 1],
		);
	});

	it('puts an entry that is larger than the character limit in its own batch', () => {
		const batches = createBatches([make('a', 'x'.repeat(50)), make('b', 'y')], {
			batchSize: 10,
			maxBatchChars: 10,
		});
		assert.deepEqual(
			batches.map((batch) => batch.length),
			[1, 1],
		);
	});

	it('does not put two entries with the same key in one batch', () => {
		const batches = createBatches([make('a.b', '1'), { id: 'other', key: 'a.b', value: '2' }], {
			batchSize: 10,
			maxBatchChars: 1000,
		});
		assert.equal(batches.length, 2);
	});
});

describe('validateTranslation', () => {
	const cases = [
		['accepts a valid translation', 'Hello {name}', 'Hallo {name}', null],
		['rejects missing placeholders', 'Hello {name}', 'Hallo', 'placeholders differ'],
		['rejects renamed placeholders', 'Hello {name}', 'Hallo {Name}', 'placeholders differ'],
		['accepts a repeated placeholder', 'Add to {a} (needs it)', '{a} 加入（需要 {a}）', null],
		[
			'rejects a placeholder that occurs fewer times',
			'{count} item | {count} items',
			'{count} 项 | 项',
			'placeholders differ',
		],
		[
			'rejects a placeholder that the source does not have',
			'Hi {a}',
			'Hi {a} {b}',
			'placeholders differ',
		],
		[
			'accepts translated attribute text',
			'Please <a href="{url}" target="_blank" title="How to install npm">install npm</a>.',
			'請<a href="{url}" target="_blank" title="如何安裝 npm">安裝 npm</a>。',
			null,
		],
		[
			'rejects a changed attribute that is not text',
			'Please <a href="{url}" title="How to">install npm</a>.',
			'請<a href="{link}" title="如何">安裝 npm</a>。',
			'HTML tags differ',
		],
		[
			'rejects attribute text that ends the attribute early',
			'<a href="x" title="How to">install</a>',
			'<a href="x" title="如何" onclick="y">安裝</a>',
			'HTML tags differ',
		],
		[
			'accepts translated words in a literal',
			"Wrap it in {'{{double braces}}'}.",
			"Заключите это в {'{{двойные скобки}}'}.",
			null,
		],
		[
			'rejects a literal with other special characters',
			"Wrap it in {'{{double braces}}'}.",
			"Заключите это в {'{двойные скобки}'}.",
			'literals differ',
		],
		[
			'rejects more plural forms than the source has',
			'{count} item | {count} items',
			'{count} элемент | {count} элемента | {count} элементов',
			'plural segment count differs',
		],
		[
			'rejects a full-width separator between plural forms',
			'{count} item | {count} items',
			'{count} 件｜{count} 件',
			'translation has a full-width "｜", which does not divide plural forms',
		],
		['accepts fewer line break tags', 'a<br />\n\tb<br />c', '甲<br />乙丙', null],
		['accepts no line break tags', 'a<br />b', '甲乙', null],
		['accepts a line break tag in another notation', 'a<br />b', '甲<br>乙', null],
		['rejects more line break tags', 'a<br />b', '甲<br />乙<br />丙', 'HTML tags differ'],
		[
			'rejects a line break tag that the source does not have',
			'a b',
			'甲<br />乙',
			'HTML tags differ',
		],
		['accepts reordered placeholders', '{a} of {b}', '{b} von {a}', null],
		['rejects changed linked messages', 'See @:a.b', 'Siehe @:a.c', 'linked messages differ'],
		['rejects missing linked messages', '@:a.b', 'Abbrechen', 'linked messages differ'],
		[
			'accepts one form with the tokens of the last plural form',
			'1 item | {n} items',
			'{n} 项',
			null,
		],
		[
			'accepts one form for plural forms with the same tokens',
			', {count} sub-execution | , {count} sub-executions',
			'，{count} 个子执行',
			null,
		],
		[
			'rejects one form without the tokens of the last plural form',
			'1 item | {n} items',
			'1 项',
			'the translation has one plural form, and its tokens differ from the last plural form of the source',
		],
		[
			'rejects a lost plural segment',
			'no | one | {n}',
			'ein | {n}',
			'plural segment count differs',
		],
		['accepts kept plural segments', 'no | one | {n}', 'kein | ein | {n}', null],
		[
			'rejects changed HTML tags',
			'Read <b>this</b>',
			'Lies <strong>das</strong>',
			'HTML tags differ',
		],
		['rejects a missing HTML tag', 'Line <b>two</b>', 'Zeile zwei', 'HTML tags differ'],
		['accepts kept HTML tags', 'Read <a href="x">docs</a>', '<a href="x">Doku</a> lesen', null],
		['rejects an added bare @', 'Contact us', 'Kontakt @ uns', 'translation adds a bare "@"'],
		['rejects an added bare {', 'Open', 'Öffnen {', 'translation adds a bare "{"'],
		['rejects an added bare }', 'Open', 'Öffnen }', 'translation adds a bare "}"'],
		['rejects an added bare |', 'A or B', 'A | B', 'plural segment count differs'],
		['rejects an empty translation', 'Save', '  ', 'translation is empty'],
		['rejects a value that is not a string', 'Save', 42, 'translation is not a string'],
		['accepts an @ that the source has', 'Mail me @ home', 'Schreib mir @ zuhause', null],
		[
			'accepts a kept literal',
			"Add {'{{placeholders}}'} here",
			"Hier {'{{placeholders}}'} hinzufügen",
			null,
		],
		[
			'rejects a literal rewritten as braces in a tag',
			"Inside <code>{'{{ }}'}</code> is JavaScript",
			'In <code>{{ }}</code> ist JavaScript',
			'literals differ',
		],
		['rejects a literal rewritten as empty braces', "Empty: {'{}'}", 'Leer: {}', 'literals differ'],
		['rejects a changed literal', "Add {'{{x}}'}", "Füge {'[[x]]'} hinzu", 'literals differ'],
		[
			'rejects a bare brace next to a kept literal',
			"Add {'{{x}}'}",
			"Füge {'{{x}}'} { hinzu",
			'translation adds a bare "{"',
		],
		['accepts a kept @ literal', "git{'@'}github.com", "git{'@'}github.com (Beispiel)", null],
		['rejects a literal @ made bare', "git{'@'}github.com", 'git@github.com', 'literals differ'],
		[
			'rejects text right after a linked message',
			'See @:a.b',
			'点击@:a.b继续',
			'a linked message is not followed by a space or the end of the text',
		],
		[
			'rejects punctuation right after a linked message',
			'See @:a.b',
			'@:a.b，',
			'a linked message is not followed by a space or the end of the text',
		],
		[
			'rejects a period right after a linked message',
			'See @:a.b',
			'Siehe @:a.b.',
			'a linked message is not followed by a space or the end of the text',
		],
		['accepts a linked message before a space', 'See @:a.b now', 'Siehe @:a.b jetzt', null],
	];
	for (const [name, source, translation, expected] of cases) {
		it(name, () => assert.equal(validateTranslation(source, translation), expected));
	}

	it('lets a translation leave out only the optional placeholders', () => {
		const source = '{n} version{suffix}';
		assert.equal(validateTranslation(source, '{n} 个版本'), 'placeholders differ');
		assert.equal(validateTranslation(source, '{n} 个版本', ['suffix']), null);
		assert.equal(validateTranslation(source, '{n} Version{suffix}', ['suffix']), null);
		assert.equal(validateTranslation(source, '个版本', ['suffix']), 'placeholders differ');
		assert.equal(validateTranslation(source, '{n} 个版本 {x}', ['suffix']), 'placeholders differ');
	});
});

describe('validateTranslation with a locale code', () => {
	const cases = [
		['accepts a translation equal to the source', 'ar', 'Webhook', 'Webhook', null],
		['accepts a product name equal to the source', 'th', 'OpenAI', 'OpenAI', null],
		['accepts a phrase equal to the source', 'ru', 'delete all data', 'delete all data', null],
		[
			'accepts a kept literal equal to the source',
			'ja',
			"git{'@'}github.com:user/repository.git",
			"git{'@'}github.com:user/repository.git",
			null,
		],
		['accepts changed punctuation', 'zh-CN', 'Trace ID: {traceId}', 'Trace ID：{traceId}', null],
		['accepts a changed letter case', 'ko', 'Html', 'HTML', null],
		['accepts a singular form of a source word', 'zh-TW', 'Workers', 'Worker', null],
		[
			'accepts a singular form next to a placeholder',
			'ar',
			'{count} workflows',
			'{count} workflow',
			null,
		],
		['accepts a singular form of a hyphenated word', 'ja', 'Sub-agents', 'Sub-agent', null],
		['accepts reordered source words', 'ru', 'MCP URL', 'URL MCP', null],
		[
			'accepts Latin words together with text in the target script',
			'zh-CN',
			'Type "delete all data" to confirm',
			'输入"delete all data"以确认',
			null,
		],
		['accepts a Latin word together with Han text', 'zh-TW', 'Worker pool', 'Worker 池', null],
		[
			'rejects a translation in a different language',
			'ar',
			'Instance admins',
			'Administradores de la instancia',
			OTHER_LANGUAGE,
		],
		[
			'rejects a translation in a different language with a placeholder',
			'ar',
			'Node {name}',
			'Nodo {name}',
			OTHER_LANGUAGE,
		],
		[
			'rejects plural forms in a different language',
			'ar',
			'{count} node | {count} nodes',
			'{count} nodo | {count} nodos',
			OTHER_LANGUAGE,
		],
		[
			'rejects one word in a different language',
			'ar',
			'Credentials',
			'Credenciales',
			OTHER_LANGUAGE,
		],
		[
			'rejects Latin text for a Cyrillic locale',
			'ru',
			'Credentials',
			'Credenciales',
			OTHER_LANGUAGE,
		],
		['accepts Arabic text', 'ar', 'Credentials', 'بيانات الاعتماد', null],
		['does not check without a locale code', null, 'Credentials', 'Credenciales', null],
		['does not check an undefined locale code', undefined, 'Credentials', 'Credenciales', null],
		['does not check a Latin locale', 'es', 'Credentials', 'Credenciales', null],
		['does not check another Latin locale', 'vi', 'Node {name}', 'Nút {name}', null],
		['does not check a locale code that is not valid', '!!', 'Credentials', 'Credenciales', null],
		['does not check a locale without a known script', 'xx', 'Credentials', 'Credenciales', null],
		['checks other problems first', 'ar', 'Node {name}', '', 'translation is empty'],
	];
	for (const [name, localeCode, source, translation, expected] of cases) {
		it(name, () =>
			assert.equal(validateTranslation(source, translation, [], localeCode), expected));
	}
});

describe('parseModelOutput', () => {
	it('parses plain JSON', () => {
		assert.deepEqual(parseModelOutput('{"a":"b"}'), { a: 'b' });
	});

	it('removes code fences and surrounding text', () => {
		assert.deepEqual(parseModelOutput('Here you go:\n```json\n{"a": "b {x}"}\n```\nDone.'), {
			a: 'b {x}',
		});
	});

	it('removes reasoning blocks', () => {
		assert.deepEqual(parseModelOutput('<think>use {braces}</think>{"a":"b"}'), { a: 'b' });
	});

	it('rejects output without an object', () => {
		assert.throws(() => parseModelOutput('Sorry, I cannot do that.'), /no JSON object/);
		assert.throws(() => parseModelOutput('[1, 2]'), /no JSON object/);
		assert.throws(() => parseModelOutput(undefined), /not a string/);
	});
});

describe('parseRetryAfter', () => {
	it('reads seconds and HTTP dates', () => {
		assert.equal(parseRetryAfter('3', 0), 3000);
		assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4000), 6000);
		assert.equal(parseRetryAfter('soon', 0), null);
		assert.equal(parseRetryAfter(null, 0), null);
	});
});

describe('requestBatch', () => {
	const batch = flattenMessages({ 'a.b': 'Save', c: 'Cancel' });

	it('sends an authenticated request and parses the result', async () => {
		const calls = [];
		const { deps } = testDeps({ fetch: translatingFetch((value) => `DE ${value}`, calls) });
		const result = await requestBatch(batch, {
			api: API,
			locale: LOCALE,
			settings: { ...SETTINGS, requestOptions: { temperature: 0.2 } },
			deps,
		});
		assert.deepEqual(result, { ok: true, translations: { 'a.b': 'DE Save', c: 'DE Cancel' } });
		assert.equal(calls[0].url, 'https://llm.example.test/v1/chat/completions');
		assert.equal(calls[0].init.headers.authorization, 'Bearer secret');
		const body = JSON.parse(calls[0].init.body);
		assert.equal(body.model, 'test-model');
		assert.equal(body.temperature, 0.2);
		assert.equal(body.response_format, undefined);
		assert.ok(calls[0].init.signal instanceof AbortSignal);
	});

	it('retries 429, 5xx, network errors, and bad output, and respects Retry-After', async () => {
		const replies = [
			() => response(429, 'slow down', { 'retry-after': '7' }),
			() => response(503, 'unavailable'),
			() => {
				throw new TypeError('fetch failed');
			},
			() => completion('not json'),
			() => completion('{"a.b":"Speichern","c":"Abbrechen"}'),
		];
		let index = 0;
		const { deps, sleeps } = testDeps({ fetch: async () => replies[index++]() });
		const result = await requestBatch(batch, {
			api: API,
			locale: LOCALE,
			settings: { ...SETTINGS, maxAttempts: 5 },
			deps,
		});
		assert.equal(result.ok, true);
		assert.equal(index, 5);
		assert.deepEqual(sleeps, [7000, 4000, 8000, 16000]);
	});

	it('gives up after the maximum number of attempts', async () => {
		let count = 0;
		const { deps } = testDeps({
			fetch: async () => {
				count++;
				return response(500, 'boom');
			},
		});
		const result = await requestBatch(batch, {
			api: API,
			locale: LOCALE,
			settings: SETTINGS,
			deps,
		});
		assert.equal(result.ok, false);
		assert.match(result.reason, /HTTP 500 after 3 attempts/);
		assert.equal(count, 3);
	});

	it('does not retry other client errors', async () => {
		let count = 0;
		const { deps } = testDeps({
			fetch: async () => {
				count++;
				return response(400, 'bad request');
			},
		});
		const result = await requestBatch(batch, {
			api: API,
			locale: LOCALE,
			settings: SETTINGS,
			deps,
		});
		assert.equal(result.ok, false);
		assert.equal(count, 1);
	});

	for (const status of [401, 403, 404]) {
		it(`stops on HTTP ${status}`, async () => {
			const { deps } = testDeps({ fetch: async () => response(status, 'nope') });
			await assert.rejects(
				requestBatch(batch, {
					api: API,
					locale: LOCALE,
					settings: SETTINGS,
					deps,
				}),
				FatalApiError,
			);
		});
	}
});

describe('Anthropic API format', () => {
	const anthropic = { ...SETTINGS, apiFormat: 'anthropic', anthropicVersion: '2026-10-21' };
	const messages = [
		{ role: 'system', content: 'Translate to German.' },
		{ role: 'user', content: 'Save' },
	];

	/** Creates an Anthropic Messages response with the given content blocks and stop reason. */
	const message = (content, stopReason = 'end_turn', extra = {}) =>
		response(200, {
			type: 'message',
			role: 'assistant',
			content,
			stop_reason: stopReason,
			...extra,
		});

	it('keeps the OpenAI request when no API format is set', () => {
		assert.deepEqual(
			buildApiRequest(messages, {
				api: API,
				settings: { ...SETTINGS, requestOptions: { temperature: 0 } },
			}),
			{
				url: 'https://llm.example.test/v1/chat/completions',
				headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
				body: { model: 'test-model', messages, temperature: 0, stream: false },
			},
		);
	});

	it('builds a Messages request with the system prompt as a top-level field', () => {
		const request = buildApiRequest(messages, { api: API, settings: anthropic });
		assert.equal(request.url, 'https://llm.example.test/v1/messages');
		assert.deepEqual(request.headers, {
			'content-type': 'application/json',
			'x-api-key': 'secret',
			'anthropic-version': '2026-10-21',
		});
		assert.deepEqual(request.body, {
			model: 'test-model',
			max_tokens: 16000,
			system: 'Translate to German.',
			messages: [{ role: 'user', content: 'Save' }],
			stream: false,
		});
	});

	it('asks for a response without streaming in each API format', () => {
		for (const settings of [SETTINGS, anthropic]) {
			const request = buildApiRequest(messages, {
				api: API,
				settings: { ...settings, requestOptions: { stream: true } },
			});
			assert.equal(request.body.stream, false);
		}
	});

	it('adds the version path only when the base URL does not have it', () => {
		const urlFor = (baseUrl) =>
			buildApiRequest(messages, { api: { ...API, baseUrl }, settings: anthropic }).url;
		assert.equal(urlFor('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
		assert.equal(urlFor('https://api.anthropic.com/'), 'https://api.anthropic.com/v1/messages');
		assert.equal(
			urlFor('https://gateway.test/claude/v1/'),
			'https://gateway.test/claude/v1/messages',
		);
	});

	it('lets the request options and the configuration set max_tokens and the version', () => {
		const request = buildApiRequest([{ role: 'user', content: 'Save' }], {
			api: API,
			settings: {
				...anthropic,
				anthropicVersion: '2023-06-01',
				requestOptions: { max_tokens: 512 },
			},
		});
		assert.equal(request.headers['anthropic-version'], '2023-06-01');
		assert.deepEqual(request.body, {
			model: 'test-model',
			max_tokens: 512,
			messages: [{ role: 'user', content: 'Save' }],
			stream: false,
		});
	});

	it('reads the text blocks and the stop state of a Messages response', () => {
		assert.deepEqual(
			readApiResponse(
				{
					content: [
						{ type: 'thinking', thinking: '', signature: 'x' },
						{ type: 'text', text: '{"a":' },
						{ type: 'text', text: '"b"}' },
					],
					stop_reason: 'end_turn',
				},
				'anthropic',
			),
			{ content: '{"a":"b"}', cutOff: false, refusal: null },
		);
		assert.equal(
			readApiResponse({ content: [], stop_reason: 'max_tokens' }, 'anthropic').cutOff,
			true,
		);
		assert.equal(
			readApiResponse(
				{ content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' } },
				'anthropic',
			).refusal,
			'cyber',
		);
		assert.equal(
			readApiResponse({ content: [], stop_reason: 'refusal' }, 'anthropic').refusal,
			'no category',
		);
		assert.equal(readApiResponse({ type: 'error' }, 'anthropic').content, undefined);
		assert.deepEqual(
			readApiResponse(
				{ choices: [{ finish_reason: 'length', message: { content: 'x' } }] },
				undefined,
			),
			{ content: 'x', cutOff: true, refusal: null },
		);
	});

	it('translates a batch through the Messages API', async () => {
		const calls = [];
		const { deps } = testDeps({
			fetch: async (url, init) => {
				calls.push({ url, init });
				const payload = JSON.parse(JSON.parse(init.body).messages[0].content);
				const result = Object.fromEntries(
					Object.entries(payload).map(([key, value]) => [key, `DE ${value}`]),
				);
				return message([{ type: 'text', text: JSON.stringify(result) }]);
			},
		});
		const result = await requestBatch(flattenMessages({ 'a.b': 'Save', c: 'Cancel' }), {
			api: API,
			locale: LOCALE,
			settings: anthropic,
			deps,
		});
		assert.deepEqual(result, { ok: true, translations: { 'a.b': 'DE Save', c: 'DE Cancel' } });
		assert.equal(calls[0].url, 'https://llm.example.test/v1/messages');
		assert.equal(calls[0].init.headers['x-api-key'], 'secret');
		assert.equal(calls[0].init.headers.authorization, undefined);
		const body = JSON.parse(calls[0].init.body);
		assert.match(body.system, /^You translate user interface strings/);
		assert.deepEqual(
			body.messages.map((item) => item.role),
			['user'],
		);
	});

	it('retries an overloaded response and reports a cut-off or declined reply without a retry', async () => {
		const replies = [
			() =>
				response(529, {
					type: 'error',
					error: { type: 'overloaded_error', message: 'Overloaded' },
				}),
			() =>
				response(
					429,
					{ type: 'error', error: { type: 'rate_limit_error', message: 'slow' } },
					{ 'retry-after': '3' },
				),
			() => message([{ type: 'text', text: '{"a":"Speichern"}' }]),
		];
		let index = 0;
		const first = testDeps({ fetch: async () => replies[index++]() });
		const ok = await requestBatch(flattenMessages({ a: 'Save' }), {
			api: API,
			locale: LOCALE,
			settings: anthropic,
			deps: first.deps,
		});
		assert.deepEqual(ok, { ok: true, translations: { a: 'Speichern' } });
		assert.deepEqual(first.sleeps, [2000, 3000]);

		for (const [reply, pattern] of [
			[message([{ type: 'text', text: '{"a":' }], 'max_tokens'), /max_tokens/],
			[
				message([], 'refusal', { stop_details: { category: 'cyber' } }),
				/declined the request \(cyber\)/,
			],
		]) {
			let count = 0;
			const { deps } = testDeps({
				fetch: async () => {
					count++;
					return reply;
				},
			});
			const result = await requestBatch(flattenMessages({ a: 'Save' }), {
				api: API,
				locale: LOCALE,
				settings: anthropic,
				deps,
			});
			assert.equal(result.ok, false);
			assert.match(result.reason, pattern);
			assert.equal(count, 1);
		}
	});

	it('stops with a fatal error when the key or the model is not valid', async () => {
		const { deps } = testDeps({
			fetch: async () =>
				response(401, {
					type: 'error',
					error: { type: 'authentication_error', message: 'invalid x-api-key' },
				}),
		});
		await assert.rejects(
			requestBatch(flattenMessages({ a: 'Save' }), {
				api: API,
				locale: LOCALE,
				settings: anthropic,
				deps,
			}),
			(error) => error instanceof FatalApiError && /invalid x-api-key/.test(error.message),
		);
	});
});

describe('translateLocale', () => {
	it('translates pending entries, copies linked messages, and drops invalid translations', async () => {
		const { deps, logs } = testDeps({
			fetch: translatingFetch((value) => (value.includes('{count}') ? 'Elemente' : `DE ${value}`)),
		});
		const result = await translateLocale({
			sourceMessages: SOURCE,
			translations: new Map(),
			state: new Map(),
			locale: LOCALE,
			settings: SETTINGS,
			api: API,
			deps,
		});
		const output = buildOrdered(SOURCE, result.translations);
		assert.deepEqual(output, {
			'app.title': 'DE Workflows',
			_reusableBaseText: { cancel: 'DE Cancel', roles: { admin: 'DE Admin' } },
			'app.cancel': '@:_reusableBaseText.cancel',
			'app.link': 'DE Read the <a href="https://docs.n8n.io">docs</a>',
		});
		assert.equal(result.stats.added, 5);
		assert.equal(result.stats.rejected, 1);
		assert.equal(result.stats.failed, 0);
		assert.equal(result.stats.translated, 5);
		assert.deepEqual(
			logs.filter((line) => line.startsWith('Rejected ')),
			[
				'Rejected app.count: the translation has one plural form, and its tokens differ from the last plural form of the source. The model returned: "Elemente"',
			],
		);
		assert.equal(result.state.get(JSON.stringify(['app.title'])), hashSource('Workflows'));
	});

	it('asks the model one time to correct rejected translations', async () => {
		const calls = [];
		const { deps, logs } = testDeps({
			fetch: translatingFetch(
				(value, key, correction) =>
					key === 'app.count' && !correction ? 'Elemente' : `DE ${value}`,
				calls,
			),
		});
		const result = await translateLocale({
			sourceMessages: SOURCE,
			translations: new Map(),
			state: new Map(),
			locale: LOCALE,
			settings: SETTINGS,
			api: API,
			deps,
		});
		assert.equal(
			result.translations.get(JSON.stringify(['app.count'])),
			'DE 1 item | {count} items',
		);
		assert.equal(result.stats.corrected, 1);
		assert.equal(result.stats.rejected, 0);
		assert.equal(result.stats.translated, 6);
		assert.deepEqual(
			logs.filter((line) => line.startsWith('Rejected ')),
			[],
		);
		const corrections = calls
			.map((call) => JSON.parse(call.init.body).messages[1].content)
			.filter((content) => content.includes('An automatic check rejected'));
		assert.equal(corrections.length, 1);
		assert.match(corrections[0], /"translation": "Elemente"/);
		assert.match(corrections[0], /"problem": "the translation has one plural form/);
		assert.doesNotMatch(corrections[0], /app\.title/);
	});

	it('asks the model one time to correct a translation in a different language', async () => {
		const calls = [];
		const { deps, logs } = testDeps({
			fetch: translatingFetch(
				(value, key, correction) => (correction ? 'العقدة {name}' : 'Nodo {name}'),
				calls,
			),
		});
		const result = await translateLocale({
			sourceMessages: { node: 'Node {name}' },
			translations: new Map(),
			state: new Map(),
			locale: ARABIC,
			settings: SETTINGS,
			api: API,
			deps,
		});
		assert.equal(result.translations.get(JSON.stringify(['node'])), 'العقدة {name}');
		assert.equal(result.stats.corrected, 1);
		assert.equal(result.stats.rejected, 0);
		assert.deepEqual(
			logs.filter((line) => line.startsWith('Rejected ')),
			[],
		);
		const corrections = calls
			.map((call) => JSON.parse(call.init.body).messages[1].content)
			.filter((content) => content.includes('An automatic check rejected'));
		assert.equal(corrections.length, 1);
		assert.match(corrections[0], /"translation": "Nodo \{name\}"/);
		assert.ok(corrections[0].includes(`"problem": "${OTHER_LANGUAGE}"`));
	});

	it('translates a stored translation in a different language again', async () => {
		const calls = [];
		const { deps } = testDeps({ fetch: translatingFetch(() => 'بيانات الاعتماد', calls) });
		const id = JSON.stringify(['creds']);
		const result = await translateLocale({
			sourceMessages: { creds: 'Credentials' },
			translations: new Map([[id, 'Credenciales']]),
			state: new Map([[id, hashSource('Credentials')]]),
			locale: ARABIC,
			settings: SETTINGS,
			api: API,
			deps,
		});
		assert.equal(calls.length, 1);
		assert.equal(result.stats.pending, 1);
		assert.equal(result.translations.get(id), 'بيانات الاعتماد');
	});

	it('does not ask for a correction after a fatal API error', async () => {
		let count = 0;
		const { deps } = testDeps({
			fetch: async (url, init) => {
				count++;
				if (count > 1) return response(401, 'invalid key');
				const payload = JSON.parse(JSON.parse(init.body).messages[1].content);
				return completion(
					JSON.stringify(Object.fromEntries(Object.keys(payload).map((key) => [key, '{x}']))),
				);
			},
		});
		const source = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`k${i}`, `Text ${i}`]));
		const result = await translateLocale({
			sourceMessages: source,
			translations: new Map(),
			state: new Map(),
			locale: LOCALE,
			settings: { ...SETTINGS, batchSize: 1, concurrency: 1 },
			api: API,
			deps,
		});
		assert.equal(count, 2);
		assert.equal(result.stats.rejected, 1);
		assert.equal(result.stats.corrected, 0);
		assert.equal(result.stats.skipped, 2);
	});

	it('accepts a translation that leaves out an optional placeholder', async () => {
		const { deps } = testDeps({ fetch: translatingFetch(() => '{n} 个版本') });
		const result = await translateLocale({
			sourceMessages: { versions: '{n} version{suffix}' },
			translations: new Map(),
			state: new Map(),
			locale: LOCALE,
			settings: { ...SETTINGS, optionalPlaceholders: ['suffix'] },
			api: API,
			deps,
		});
		assert.equal(result.stats.rejected, 0);
		assert.deepEqual(buildOrdered({ versions: '' }, result.translations), {
			versions: '{n} 个版本',
		});
	});

	it('counts keys that the model left out as failed', async () => {
		const { deps } = testDeps({
			fetch: async () => completion('{"app.title": "Arbeitsabläufe"}'),
		});
		const result = await translateLocale({
			sourceMessages: { 'app.title': 'Workflows', other: 'Other' },
			translations: new Map(),
			state: new Map(),
			locale: LOCALE,
			settings: SETTINGS,
			api: API,
			deps,
		});
		assert.equal(result.stats.added, 1);
		assert.equal(result.stats.failed, 1);
	});

	it('does not send entries that are up to date', async () => {
		const calls = [];
		const { deps } = testDeps({ fetch: translatingFetch((value) => `DE ${value}`, calls) });
		const source = { a: 'One', b: 'Two' };
		const result = await translateLocale({
			sourceMessages: source,
			translations: new Map([[JSON.stringify(['a']), 'Eins (manuell)']]),
			state: new Map([[JSON.stringify(['a']), hashSource('One')]]),
			locale: LOCALE,
			settings: SETTINGS,
			api: API,
			deps,
		});
		assert.equal(calls.length, 1);
		assert.deepEqual(Object.keys(JSON.parse(JSON.parse(calls[0].init.body).messages[1].content)), [
			'b',
		]);
		assert.deepEqual(buildOrdered(source, result.translations), {
			a: 'Eins (manuell)',
			b: 'DE Two',
		});
	});

	it('stops the run on a fatal API error', async () => {
		let count = 0;
		const { deps } = testDeps({
			fetch: async () => {
				count++;
				return response(401, 'invalid key');
			},
		});
		const source = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, `Text ${i}`]));
		const result = await translateLocale({
			sourceMessages: source,
			translations: new Map(),
			state: new Map(),
			locale: LOCALE,
			settings: { ...SETTINGS, batchSize: 1, concurrency: 1 },
			api: API,
			deps,
		});
		assert.equal(count, 1);
		assert.match(result.stats.fatalError, /HTTP 401/);
		assert.equal(result.stats.skipped, 9);
	});
});

describe('main', () => {
	let dir;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	/** Creates an i18n directory and a source file in a temporary directory. */
	function setup({ locales, state } = {}) {
		dir = mkdtempSync(join(tmpdir(), 'i18n-translate-test-'));
		const i18nDir = join(dir, 'i18n');
		mkdirSync(join(i18nDir, 'locales'), { recursive: true });
		mkdirSync(join(i18nDir, 'state'), { recursive: true });
		writeFileSync(
			join(i18nDir, 'config.json'),
			JSON.stringify({
				locales: [LOCALE],
				batchSize: 2,
				maxBatchChars: 1000,
				concurrency: 2,
				maxAttempts: 2,
				requestOptions: {},
			}),
		);
		if (locales) writeFileSync(join(i18nDir, 'locales', 'de.json'), JSON.stringify(locales));
		if (state) writeFileSync(join(i18nDir, 'state', 'de.json'), JSON.stringify(state));
		const source = join(dir, 'en.json');
		writeFileSync(source, `${JSON.stringify(SOURCE, null, '\t')}\n`);
		return { i18nDir, source, summary: join(dir, 'summary.md') };
	}

	/** Returns the environment with API settings. */
	const apiEnv = (summary) => ({
		I18N_API_BASE_URL: API.baseUrl,
		I18N_MODEL: API.model,
		I18N_API_KEY: API.apiKey,
		GITHUB_STEP_SUMMARY: summary,
	});

	it('writes ordered files, the state, and the step summary', async () => {
		const { i18nDir, source, summary } = setup();
		const { deps, logs } = testDeps({ fetch: translatingFetch((value) => `DE ${value}`) });
		const code = await main(['--source', source, '--locale', 'de', '--i18n-dir', i18nDir], {
			env: apiEnv(summary),
			...deps,
		});
		assert.equal(code, 0, logs.join('\n'));
		const text = readFileSync(join(i18nDir, 'locales', 'de.json'), 'utf8');
		assert.ok(text.endsWith('}\n'));
		assert.ok(text.startsWith('{\n\t"app.title"'));
		assert.deepEqual(Object.keys(JSON.parse(text)), Object.keys(SOURCE));
		const state = JSON.parse(readFileSync(join(i18nDir, 'state', 'de.json'), 'utf8'));
		assert.equal(state._reusableBaseText.roles.admin, hashSource('Admin'));
		const markdown = readFileSync(summary, 'utf8');
		assert.match(markdown, /UI translation: de/);
		assert.match(markdown, /\| Coverage \| 100\.0% \|/);
	});

	it('only removes deleted keys when the API is not configured', async () => {
		const { i18nDir, source, summary } = setup({
			locales: { 'app.title': 'Alt', gone: 'Weg' },
			state: { 'app.title': hashSource('Old'), gone: 'x' },
		});
		const { deps, logs } = testDeps({
			fetch: async () => assert.fail('fetch must not be called'),
		});
		const code = await main(['--source', source, '--locale', 'de', '--i18n-dir', i18nDir], {
			env: { GITHUB_STEP_SUMMARY: summary },
			...deps,
		});
		assert.equal(code, 0);
		assert.match(logs.join('\n'), /::warning::/);
		assert.deepEqual(JSON.parse(readFileSync(join(i18nDir, 'locales', 'de.json'), 'utf8')), {
			'app.title': 'Alt',
		});
		assert.deepEqual(JSON.parse(readFileSync(join(i18nDir, 'state', 'de.json'), 'utf8')), {
			'app.title': hashSource('Old'),
		});
	});

	it('does not create empty files when the API is not configured', async () => {
		const { i18nDir, source } = setup();
		const { deps } = testDeps();
		const code = await main(['--source', source, '--locale', 'de', '--i18n-dir', i18nDir], {
			env: {},
			...deps,
		});
		assert.equal(code, 0);
		assert.equal(existsSync(join(i18nDir, 'locales', 'de.json')), false);
	});

	it('returns a non-zero code when no batch succeeds', async () => {
		const { i18nDir, source, summary } = setup();
		const { deps, logs } = testDeps({ fetch: async () => response(500, 'boom') });
		const code = await main(['--source', source, '--locale', 'de', '--i18n-dir', i18nDir], {
			env: apiEnv(summary),
			...deps,
		});
		assert.equal(code, 1);
		assert.match(logs.join('\n'), /::error::No batch/);
		assert.deepEqual(
			Object.keys(JSON.parse(readFileSync(join(i18nDir, 'locales', 'de.json'), 'utf8'))),
			['app.cancel'],
		);
	});

	it('returns zero with a warning when some batches fail', async () => {
		const { i18nDir, source, summary } = setup();
		let count = 0;
		const ok = translatingFetch((value) => `DE ${value}`);
		const { deps, logs } = testDeps({
			fetch: async (url, init) => (count++ === 0 ? ok(url, init) : response(400, 'bad')),
		});
		const code = await main(['--source', source, '--locale', 'de', '--i18n-dir', i18nDir], {
			env: { ...apiEnv(summary), I18N_CONCURRENCY: '1' },
			...deps,
		});
		assert.equal(code, 0);
		assert.match(logs.join('\n'), /::warning::\d+ entries for de were not translated/);
	});

	it('returns a non-zero code on a fatal API error', async () => {
		const { i18nDir, source, summary } = setup();
		const { deps } = testDeps({ fetch: async () => response(403, 'forbidden') });
		const code = await main(['--source', source, '--locale', 'de', '--i18n-dir', i18nDir], {
			env: apiEnv(summary),
			...deps,
		});
		assert.equal(code, 1);
	});

	it('returns the usage code for bad arguments and configuration', async () => {
		const { i18nDir, source } = setup();
		const { deps } = testDeps();
		assert.equal(await main(['--locale', 'de'], { env: {}, ...deps }), 2);
		assert.equal(
			await main(['--source', source, '--locale', 'fr', '--i18n-dir', i18nDir], {
				env: {},
				...deps,
			}),
			2,
		);
		assert.equal(
			await main(
				['--source', source, '--locale', 'de', '--i18n-dir', i18nDir, '--no-such-option', 'x'],
				{
					env: {},
					...deps,
				},
			),
			2,
		);
		assert.equal(
			await main(['--source', source, '--locale', 'de', '--i18n-dir', i18nDir], {
				env: { ...apiEnv(''), I18N_CONCURRENCY: 'many' },
				...deps,
			}),
			2,
		);
		const config = JSON.parse(readFileSync(join(i18nDir, 'config.json'), 'utf8'));
		writeFileSync(
			join(i18nDir, 'config.json'),
			JSON.stringify({ ...config, requestOptions: { stream: true } }),
		);
		const logs = [];
		assert.equal(
			await main(['--source', source, '--locale', 'de', '--i18n-dir', i18nDir], {
				env: {},
				...deps,
				log: (message) => logs.push(message),
			}),
			2,
		);
		assert.match(logs[0], /requestOptions\.stream/);
		writeFileSync(
			join(i18nDir, 'config.json'),
			JSON.stringify({ ...config, optionalPlaceholders: 'howManySuffix' }),
		);
		assert.equal(
			await main(['--source', source, '--locale', 'de', '--i18n-dir', i18nDir], {
				env: {},
				...deps,
				log: (message) => logs.push(message),
			}),
			2,
		);
		assert.match(logs[1], /optionalPlaceholders/);
		writeFileSync(join(i18nDir, 'config.json'), '{"locales": []}');
		assert.equal(
			await main(['--source', source, '--locale', 'de', '--i18n-dir', i18nDir], {
				env: {},
				...deps,
			}),
			2,
		);
	});

	it('returns the usage code when a translation file is not valid JSON', async () => {
		const { i18nDir, source } = setup();
		writeFileSync(join(i18nDir, 'locales', 'de.json'), '{ broken');
		const { deps } = testDeps();
		assert.equal(
			await main(['--source', source, '--locale', 'de', '--i18n-dir', i18nDir], {
				env: {},
				...deps,
			}),
			2,
		);
		assert.equal(readFileSync(join(i18nDir, 'locales', 'de.json'), 'utf8'), '{ broken');
	});

	it('reads existing nested files', () => {
		const map = toValueMap({ _reusableBaseText: { cancel: 'Abbrechen' } });
		assert.equal(map.get(JSON.stringify(['_reusableBaseText', 'cancel'])), 'Abbrechen');
	});
});
