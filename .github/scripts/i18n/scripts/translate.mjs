#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** Default i18n directory, which is the parent of the scripts directory. */
export const DEFAULT_I18N_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Default timeout of one API request in milliseconds. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** Shortest time in milliseconds between two saves of partial results during a run. */
const CHECKPOINT_INTERVAL_MS = 30_000;

/** Largest number of rejected entries that one run writes to the log. */
const MAX_REJECTION_LOG_LINES = 100;

/** Upper limit of one retry delay in milliseconds. */
const MAX_RETRY_DELAY_MS = 300_000;

/** Exit code for usage and configuration file errors. */
const EXIT_USAGE = 2;

/** Exit code for runs that could not translate anything. */
const EXIT_FAILURE = 1;

/** Pattern of vue-i18n linked messages such as `@:key` or `@.lower:key`. */
const LINK_SOURCE = String.raw`@(?:\.[A-Za-z]+)?:(?:\{'(?:[^'\\]|\\.)*'\}|[\w$-]+(?:\.[\w$-]+)*)`;

/** Pattern of vue-i18n literals such as `{'@'}` or `{'{{ }}'}`. */
const LITERAL_SOURCE = String.raw`\{\s*'(?:[^'\\]|\\.)*'\s*\}`;

/** Pattern of vue-i18n placeholders such as `{name}`. */
const PLACEHOLDER_SOURCE = String.raw`\{[^{}]*\}`;

/** Pattern of HTML tags. */
const HTML_TAG_SOURCE = String.raw`<\/?[A-Za-z][^<>]*>`;

/** Pattern of an HTML line break tag. */
const LINE_BREAK_TAG_PATTERN = /^<br\s*\/?>$/i;

/** Pattern of an HTML attribute whose value is text for the user, with the value in quotation marks. */
const TEXT_ATTRIBUTE_PATTERN =
	/(\s(?:title|alt|aria-label|placeholder)\s*=\s*)(?:"[^"]*"|'[^']*')/gi;

/** Kinds of message tokens, in the order of the groups in the token pattern. */
const TOKEN_KINDS = ['links', 'literals', 'placeholders', 'tags'];

/** Pattern that splits a message into tokens from left to right, with literals before placeholders. */
const TOKEN_PATTERN = new RegExp(
	[LINK_SOURCE, LITERAL_SOURCE, PLACEHOLDER_SOURCE, HTML_TAG_SOURCE]
		.map((source) => `(${source})`)
		.join('|'),
	'g',
);

/** Characters with special meaning in vue-i18n messages that a translation must not add. */
const SPECIAL_CHARACTERS = ['@', '{', '}', '|'];

/** Unicode script names for each ISO 15924 code that stands for a combination of scripts. */
const COMBINED_SCRIPTS = {
	Hans: ['Han'],
	Hant: ['Han'],
	Jpan: ['Han', 'Hiragana', 'Katakana'],
	Kore: ['Hangul', 'Han'],
};

/** Pattern of a word with at least three Latin letters. */
const LATIN_WORD_PATTERN = /\p{Script=Latin}{3,}/gu;

/** Patterns of one character in the script of each locale code, or null when the check does not apply. */
const targetScriptPatterns = new Map();

/** API formats: OpenAI chat completions, or Anthropic Messages. */
const API_FORMATS = ['openai', 'anthropic'];

/** API version that Anthropic Messages requests send when the configuration sets none. */
const DEFAULT_ANTHROPIC_VERSION = '2026-10-21';

/** Output token limit of Anthropic Messages requests when the request options set none. */
const DEFAULT_ANTHROPIC_MAX_TOKENS = 16000;

/** Locale code format accepted from the command line and the configuration file. */
const LOCALE_CODE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** Error for usage and configuration problems. */
export class UsageError extends Error {}

/** Error for API responses that show a wrong endpoint, model, or key. */
export class FatalApiError extends Error {}

/** Returns true when the value is a plain object. */
export function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Flattens a nested message object into string leaf entries in source order. */
export function flattenMessages(messages, prefix = []) {
	const entries = [];
	if (!isPlainObject(messages)) return entries;
	for (const [name, value] of Object.entries(messages)) {
		const path = [...prefix, name];
		if (typeof value === 'string') {
			entries.push({ id: JSON.stringify(path), path, key: path.join('.'), value });
		} else if (isPlainObject(value)) {
			entries.push(...flattenMessages(value, path));
		}
	}
	return entries;
}

/** Builds a nested object with the shape and key order of the source from a map of entry ids to values. */
export function buildOrdered(source, values, prefix = []) {
	const result = {};
	for (const [name, value] of Object.entries(source)) {
		const path = [...prefix, name];
		if (typeof value === 'string') {
			const id = JSON.stringify(path);
			if (values.has(id)) result[name] = values.get(id);
		} else if (isPlainObject(value)) {
			const child = buildOrdered(value, values, path);
			if (Object.keys(child).length > 0) result[name] = child;
		}
	}
	return result;
}

/** Converts a nested message object into a map of entry ids to string values. */
export function toValueMap(messages) {
	return new Map(flattenMessages(messages).map((entry) => [entry.id, entry.value]));
}

/** Returns the hash of an English source string that the state file records. */
export function hashSource(value) {
	return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Returns copies of the translation and state maps without the entries that the source no longer has. */
export function pruneRemoved(entries, translations, state) {
	const ids = new Set(entries.map((entry) => entry.id));
	const keep = (map) => new Map([...map].filter(([id]) => ids.has(id)));
	const keptTranslations = keep(translations);
	const keptState = keep(state);
	const removed = new Set([...translations.keys(), ...state.keys()].filter((id) => !ids.has(id)))
		.size;
	return { translations: keptTranslations, state: keptState, removed };
}

/** Returns "keep" for a valid up-to-date translation, "adopt" for a valid translation without a state record, or "translate". */
export function classifyEntry(
	entry,
	translations,
	state,
	optionalPlaceholders = [],
	localeCode = null,
) {
	if (!translations.has(entry.id)) return 'translate';
	if (
		validateTranslation(
			entry.value,
			translations.get(entry.id),
			optionalPlaceholders,
			localeCode,
		) !== null
	) {
		return 'translate';
	}
	const recorded = state.get(entry.id);
	if (recorded === hashSource(entry.value)) return 'keep';
	return recorded === undefined ? 'adopt' : 'translate';
}

/** Splits the source entries into kept translations and entries that need translation. */
export function planTranslation(
	entries,
	translations,
	state,
	optionalPlaceholders = [],
	localeCode = null,
) {
	const pruned = pruneRemoved(entries, translations, state);
	const pending = [];
	let adopted = 0;
	for (const entry of entries) {
		const decision = classifyEntry(
			entry,
			pruned.translations,
			pruned.state,
			optionalPlaceholders,
			localeCode,
		);
		if (decision === 'adopt') {
			pruned.state.set(entry.id, hashSource(entry.value));
			adopted++;
		} else if (decision === 'translate') {
			pending.push(entry);
			pruned.translations.delete(entry.id);
			pruned.state.delete(entry.id);
		}
	}
	return { ...pruned, pending, adopted };
}

/** Splits a message into linked messages, literals, placeholders, HTML tags, and the remaining bare text. */
export function tokenize(message) {
	const tokens = { links: [], literals: [], placeholders: [], tags: [], linkFollowers: [] };
	let bare = '';
	let last = 0;
	for (const match of message.matchAll(TOKEN_PATTERN)) {
		const kind = TOKEN_KINDS[match.slice(1).findIndex((group) => group !== undefined)];
		tokens[kind].push(match[0]);
		const end = match.index + match[0].length;
		if (kind === 'links') tokens.linkFollowers.push(message.charAt(end));
		bare += message.slice(last, match.index);
		last = end;
	}
	bare += message.slice(last);
	return { ...tokens, bare };
}

/** Splits a message into its plural forms at each "|" that is not inside a token. */
export function splitPluralForms(message) {
	const forms = [''];
	const addBare = (text) => {
		const [first, ...rest] = text.split('|');
		forms[forms.length - 1] += first;
		forms.push(...rest);
	};
	let last = 0;
	for (const match of message.matchAll(TOKEN_PATTERN)) {
		addBare(message.slice(last, match.index));
		forms[forms.length - 1] += match[0];
		last = match.index + match[0].length;
	}
	addBare(message.slice(last));
	return forms;
}

/** Returns the message without linked messages, literals, placeholders, and HTML tags. */
export function bareText(message) {
	return tokenize(message).bare;
}

/** Returns true when a message has no text to translate. */
export function isPassthrough(message) {
	return !/\p{L}/u.test(bareText(message));
}

/** Returns true when two string lists contain the same items in any order. */
function sameItems(left, right) {
	const sortedRight = [...right].sort();
	return (
		left.length === right.length &&
		[...left].sort().every((item, index) => item === sortedRight[index])
	);
}

/** Returns true when a translation has each source placeholder at least as many times as the source, except the optional ones, and has no other placeholder. */
function keepsPlaceholders(expected, actual, optionalPlaceholders) {
	const count = (items, item) => items.filter((other) => other === item).length;
	const isOptional = (item) => optionalPlaceholders.includes(item.slice(1, -1).trim());
	return (
		actual.every((item) => expected.includes(item)) &&
		expected.every((item) => isOptional(item) || count(actual, item) >= count(expected, item))
	);
}

/** Returns an HTML tag without the values of the attributes that hold text for the user. */
function withoutAttributeText(tag) {
	return tag.replace(TEXT_ATTRIBUTE_PATTERN, '$1""');
}

/** Returns true when a translation has the HTML tags of the source, where it can translate attribute text and can have fewer line break tags. */
function keepsTags(expected, actual) {
	const isBreak = (tag) => LINE_BREAK_TAG_PATTERN.test(tag);
	const others = (tags) => tags.filter((tag) => !isBreak(tag)).map(withoutAttributeText);
	return (
		sameItems(others(expected), others(actual)) &&
		actual.filter(isBreak).length <= expected.filter(isBreak).length
	);
}

/** Returns a literal without its letters and white space, so that a literal with translated words compares as equal. */
function literalShape(literal) {
	return literal.replace(/[\p{L}\p{M}\s]/gu, '');
}

/** Returns the reason why the tokens of a translation do not agree with the expected tokens, or null when they agree. */
function tokenMismatch(expected, actual, optionalPlaceholders) {
	if (!sameItems(expected.links, actual.links)) return 'linked messages differ';
	if (!sameItems(expected.literals.map(literalShape), actual.literals.map(literalShape))) {
		return 'literals differ';
	}
	if (!keepsPlaceholders(expected.placeholders, actual.placeholders, optionalPlaceholders)) {
		return 'placeholders differ';
	}
	if (!keepsTags(expected.tags, actual.tags)) return 'HTML tags differ';
	return null;
}

/** Returns a pattern of one character in the script of a locale, or null when the locale uses the Latin script or has no known script. */
function buildTargetScriptPattern(localeCode) {
	try {
		const script = new Intl.Locale(localeCode).maximize().script;
		if (script === undefined || script === 'Latn') return null;
		const names = COMBINED_SCRIPTS[script] ?? [script];
		return new RegExp(names.map((name) => `\\p{Script=${name}}`).join('|'), 'u');
	} catch {
		return null;
	}
}

/** Returns the cached pattern of one character in the script of a locale, or null when the check does not apply. */
function targetScriptPattern(localeCode) {
	if (!targetScriptPatterns.has(localeCode)) {
		targetScriptPatterns.set(localeCode, buildTargetScriptPattern(localeCode));
	}
	return targetScriptPatterns.get(localeCode);
}

/** Returns the lowercase Latin words of a message outside its tokens. */
function latinWords(message) {
	return tokenize(message).bare.toLowerCase().match(LATIN_WORD_PATTERN) ?? [];
}

/** Returns true when a translation has no character in the script of the locale and has a Latin word that no source word starts with or is the start of. */
function isInOtherLanguage(source, translation, localeCode) {
	if (localeCode === null || localeCode === undefined) return false;
	const pattern = targetScriptPattern(localeCode);
	if (pattern === null || pattern.test(translation)) return false;
	const sourceWords = latinWords(source);
	return latinWords(translation).some((word) =>
		sourceWords.every((other) => !other.startsWith(word) && !word.startsWith(other)),
	);
}

/** Returns the reason why a translation is not valid for its source, or null when it is valid, where one form with the tokens of the last plural form can replace all plural forms. */
export function validateTranslation(
	source,
	translation,
	optionalPlaceholders = [],
	localeCode = null,
) {
	if (typeof translation !== 'string') return 'translation is not a string';
	if (source.trim() !== '' && translation.trim() === '') return 'translation is empty';

	const expected = tokenize(source);
	const actual = tokenize(translation);
	const forms = splitPluralForms(source);
	if (forms.length > 1 && translation.includes('｜')) {
		return 'translation has a full-width "｜", which does not divide plural forms';
	}
	if (forms.length > 1 && !actual.bare.includes('|')) {
		if (tokenMismatch(tokenize(forms.at(-1)), actual, optionalPlaceholders) !== null) {
			return 'the translation has one plural form, and its tokens differ from the last plural form of the source';
		}
	} else {
		const mismatch = tokenMismatch(expected, actual, optionalPlaceholders);
		if (mismatch !== null) return mismatch;
		if (forms.length !== splitPluralForms(translation).length) {
			return 'plural segment count differs';
		}
	}
	if (actual.linkFollowers.some((character) => character !== '' && !/\s/u.test(character))) {
		return 'a linked message is not followed by a space or the end of the text';
	}
	for (const character of SPECIAL_CHARACTERS) {
		if (!expected.bare.includes(character) && actual.bare.includes(character)) {
			return `translation adds a bare "${character}"`;
		}
	}
	if (isInOtherLanguage(source, translation, localeCode)) {
		return 'translation is not in the target language: it has no text in the script of the target language and adds words that the source does not have';
	}
	return null;
}

/** Splits entries into batches limited by entry count and character count, with unique keys in each batch. */
export function createBatches(entries, { batchSize, maxBatchChars }) {
	const batches = [];
	let current = [];
	let currentChars = 0;
	let currentKeys = new Set();
	for (const entry of entries) {
		const size = entry.key.length + entry.value.length;
		const full =
			current.length >= batchSize ||
			(current.length > 0 && currentChars + size > maxBatchChars) ||
			currentKeys.has(entry.key);
		if (full) {
			batches.push(current);
			current = [];
			currentChars = 0;
			currentKeys = new Set();
		}
		current.push(entry);
		currentChars += size;
		currentKeys.add(entry.key);
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

/** Parses the JSON object that a model returned, with tolerance for code fences and extra text. */
export function parseModelOutput(content) {
	if (typeof content !== 'string') throw new Error('model output is not a string');
	const text = content
		.replace(/<think>[\s\S]*?<\/think>/g, '')
		.replace(/```[A-Za-z]*/g, '')
		.trim();
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end <= start) throw new Error('model output has no JSON object');
	const parsed = JSON.parse(text.slice(start, end + 1));
	if (!isPlainObject(parsed)) throw new Error('model output is not a JSON object');
	return parsed;
}

/** Returns the delay in milliseconds that a Retry-After header asks for, or null when it is absent or not valid. */
export function parseRetryAfter(value, nowMs) {
	if (!value) return null;
	const trimmed = value.trim();
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) return null;
	return Math.max(0, date - nowMs);
}

/** Returns the delay before a retry, from the Retry-After value or from exponential backoff. */
export function retryDelay(attempt, retryAfterMs, random = Math.random) {
	if (retryAfterMs !== null && retryAfterMs !== undefined) {
		return Math.min(MAX_RETRY_DELAY_MS, retryAfterMs);
	}
	return Math.min(60_000, 1000 * 2 ** attempt) + Math.floor(random() * 500);
}

/** Builds the chat messages that ask the model to translate one batch, with the earlier rejected translations and their problems when there are some. */
export function buildPrompt(batch, locale, previous = null) {
	const glossary = Object.entries(locale.glossary ?? {});
	const rules = [
		`You translate user interface strings of n8n, a workflow automation tool, from English to ${locale.name} (${locale.nativeName ?? locale.name}, locale code ${locale.code}).`,
		'The user sends a JSON object. Each key is a message identifier and each value is the English text.',
		'Return only one JSON object with exactly the same keys. Each value must be the translation of the English text.',
		'Keep placeholders in curly braces, such as {count} or {name}, exactly as they are.',
		'Keep linked messages that start with "@:", such as @:_reusableBaseText.cancel, exactly as they are.',
		'Keep HTML tags and their attributes exactly as they are. Translate only the text between the tags and the text of title, alt, and aria-label attributes.',
		"Text in {'...'} is literal text. Keep the {'...'} wrapper and the special characters in it. You can translate the words in it.",
		'The " | " separator divides plural forms. Return exactly the same number of forms as the English text, also when the target language has more plural forms.',
		'With two forms, the application shows the first form for the number 1 and the second form for all other numbers. With three forms, it shows the first form for 0, the second form for 1, and the third form for all other numbers.',
		'Do not add the characters @, {, }, or | if the English text does not contain them.',
		'Keep product names, code, keyboard shortcuts, URLs, and text in backticks unchanged.',
		'Use a concise, natural style that suits buttons, labels, and messages in software.',
	];
	if (glossary.length > 0) {
		rules.push(
			`Use this glossary: ${glossary.map(([term, translation]) => `"${term}" -> "${translation}"`).join('; ')}.`,
		);
	}
	const payload = Object.fromEntries(batch.map((entry) => [entry.key, entry.value]));
	const request = JSON.stringify(payload, null, 2);
	const earlier = Object.fromEntries(
		batch
			.filter((entry) => previous?.has(entry.id))
			.map((entry) => [
				entry.key,
				{ translation: previous.get(entry.id).value, problem: previous.get(entry.id).reason },
			]),
	);
	const correction =
		Object.keys(earlier).length === 0
			? ''
			: `\n\nAn automatic check rejected your earlier translations of these entries. Translate the entries again and correct the problems. The earlier translations and their problems are:\n${JSON.stringify(earlier, null, 2)}`;
	return [
		{ role: 'system', content: rules.join('\n') },
		{ role: 'user', content: `${request}${correction}` },
	];
}

/** Reads a response body as text without throwing. */
async function safeText(response) {
	try {
		return (await response.text()).slice(0, 300);
	} catch {
		return '';
	}
}

/** Builds the URL, headers, and body of one API request that asks for a JSON response without streaming, in the configured API format. */
export function buildApiRequest(messages, { api, settings }) {
	const base = api.baseUrl.replace(/\/+$/, '');
	if (settings.apiFormat !== 'anthropic') {
		return {
			url: `${base}/chat/completions`,
			headers: { 'content-type': 'application/json', authorization: `Bearer ${api.apiKey}` },
			body: { model: api.model, messages, ...settings.requestOptions, stream: false },
		};
	}
	const system = messages
		.filter((message) => message.role === 'system')
		.map((message) => message.content)
		.join('\n\n');
	return {
		url: base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`,
		headers: {
			'content-type': 'application/json',
			'x-api-key': api.apiKey,
			'anthropic-version': settings.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
		},
		body: {
			model: api.model,
			max_tokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
			...(system === '' ? {} : { system }),
			messages: messages.filter((message) => message.role !== 'system'),
			...settings.requestOptions,
			stream: false,
		},
	};
}

/** Reads the model text, the cut-off state, and the refusal category from a response body in the configured API format. */
export function readApiResponse(data, apiFormat) {
	if (apiFormat !== 'anthropic') {
		const choice = data?.choices?.[0];
		return {
			content: choice?.message?.content,
			cutOff: choice?.finish_reason === 'length',
			refusal: null,
		};
	}
	const content = Array.isArray(data?.content)
		? data.content
				.filter((block) => block?.type === 'text' && typeof block.text === 'string')
				.map((block) => block.text)
				.join('')
		: undefined;
	return {
		content,
		cutOff: data?.stop_reason === 'max_tokens',
		refusal:
			data?.stop_reason === 'refusal' ? (data?.stop_details?.category ?? 'no category') : null,
	};
}

/** Sends one batch to the model API with retries, and returns the parsed translations or a failure reason. */
export async function requestBatch(batch, context, previous = null) {
	const { api, locale, settings, deps } = context;
	const request = buildApiRequest(buildPrompt(batch, locale, previous), { api, settings });
	const body = JSON.stringify(request.body);
	let lastReason = 'no attempt was made';

	for (let attempt = 1; attempt <= settings.maxAttempts; attempt++) {
		let retryAfterMs = null;
		try {
			const response = await deps.fetch(request.url, {
				method: 'POST',
				headers: request.headers,
				body,
				signal: AbortSignal.timeout(settings.requestTimeoutMs),
			});
			if ([401, 403, 404].includes(response.status)) {
				throw new FatalApiError(
					`The API returned HTTP ${response.status}. Check I18N_API_BASE_URL, I18N_MODEL, and I18N_API_KEY. ${await safeText(response)}`.trim(),
				);
			}
			if (response.status === 429 || response.status >= 500) {
				retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'), deps.now());
				lastReason = `HTTP ${response.status}`;
			} else if (!response.ok) {
				return { ok: false, reason: `HTTP ${response.status}: ${await safeText(response)}` };
			} else {
				const reply = readApiResponse(await response.json(), settings.apiFormat);
				if (reply.cutOff) {
					return { ok: false, reason: 'the reply was cut off by the max_tokens limit' };
				}
				if (reply.refusal !== null) {
					return { ok: false, reason: `the model declined the request (${reply.refusal})` };
				}
				return { ok: true, translations: parseModelOutput(reply.content) };
			}
		} catch (error) {
			if (error instanceof FatalApiError) throw error;
			lastReason = error instanceof Error ? error.message : String(error);
		}

		if (attempt < settings.maxAttempts) {
			await deps.sleep(retryDelay(attempt, retryAfterMs, deps.random));
		}
	}

	return { ok: false, reason: `${lastReason} after ${settings.maxAttempts} attempts` };
}

/** Translates the pending entries of one locale, asks the model one time to correct the rejected translations, and returns the updated maps and statistics. */
export async function translateLocale({
	sourceMessages,
	translations,
	state,
	locale,
	settings,
	api,
	deps,
	onCheckpoint = () => {},
}) {
	const entries = flattenMessages(sourceMessages);
	const optionalPlaceholders = settings.optionalPlaceholders ?? [];
	const plan = planTranslation(entries, translations, state, optionalPlaceholders, locale.code);
	const stats = {
		total: entries.length,
		pending: plan.pending.length,
		removed: plan.removed,
		adopted: plan.adopted,
		added: 0,
		corrected: 0,
		rejected: 0,
		failed: 0,
		skipped: 0,
		batches: 0,
		successfulBatches: 0,
		translated: 0,
		fatalError: null,
	};
	const accept = (entry, value) => {
		plan.translations.set(entry.id, value);
		plan.state.set(entry.id, hashSource(entry.value));
		stats.added++;
	};

	const toModel = [];
	for (const entry of plan.pending) {
		if (isPassthrough(entry.value)) accept(entry, entry.value);
		else toModel.push(entry);
	}

	const context = { api, locale, settings, deps };
	let stopped = false;
	const runBatches = async (batches, previous, onRejected) => {
		let next = 0;
		const worker = async () => {
			while (!stopped && next < batches.length) {
				const batch = batches[next++];
				let result;
				try {
					result = await requestBatch(batch, context, previous);
				} catch (error) {
					if (!(error instanceof FatalApiError)) throw error;
					stats.fatalError = error.message;
					stats.failed += batch.length;
					stopped = true;
					break;
				}
				if (!result.ok) {
					stats.failed += batch.length;
					deps.log(
						`::warning::A batch of ${batch.length} entries for ${locale.code} failed: ${result.reason}`,
					);
					continue;
				}
				stats.successfulBatches++;
				for (const entry of batch) {
					const value = result.translations[entry.key];
					if (value === undefined) {
						stats.failed++;
						continue;
					}
					const reason = validateTranslation(entry.value, value, optionalPlaceholders, locale.code);
					if (reason) onRejected({ entry, value, reason });
					else accept(entry, value);
				}
				onCheckpoint(plan.translations, plan.state);
			}
		};
		const workerCount = Math.max(1, Math.min(settings.concurrency, batches.length));
		await Promise.all(Array.from({ length: workerCount }, worker));
		stats.batches += batches.length;
		stats.skipped += batches.slice(next).reduce((sum, batch) => sum + batch.length, 0);
	};

	const firstRejections = [];
	await runBatches(createBatches(toModel, settings), null, (item) => firstRejections.push(item));

	let rejections = firstRejections;
	if (firstRejections.length > 0 && !stopped) {
		const addedBefore = stats.added;
		const previous = new Map(firstRejections.map((item) => [item.entry.id, item]));
		rejections = [];
		await runBatches(
			createBatches(
				firstRejections.map((item) => item.entry),
				settings,
			),
			previous,
			(item) => rejections.push(item),
		);
		stats.corrected = stats.added - addedBefore;
	}

	stats.rejected = rejections.length;
	stats.translated = plan.translations.size;
	for (const { entry, value, reason } of rejections.slice(0, MAX_REJECTION_LOG_LINES)) {
		deps.log(
			`Rejected ${entry.key}: ${reason}. The model returned: ${JSON.stringify(value).slice(0, 300)}`,
		);
	}
	if (rejections.length > MAX_REJECTION_LOG_LINES) {
		deps.log(`Rejected ${rejections.length - MAX_REJECTION_LOG_LINES} more entries.`);
	}

	return { translations: plan.translations, state: plan.state, stats };
}

/** Reads and validates the translation configuration file. */
export function loadConfig(path) {
	let config;
	try {
		config = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		throw new UsageError(`Cannot read the configuration file ${path}: ${error.message}`);
	}
	if (!isPlainObject(config) || !Array.isArray(config.locales) || config.locales.length === 0) {
		throw new UsageError(`The configuration file ${path} must have a non-empty "locales" array.`);
	}
	const codes = new Set();
	for (const locale of config.locales) {
		if (
			!isPlainObject(locale) ||
			typeof locale.code !== 'string' ||
			typeof locale.name !== 'string'
		) {
			throw new UsageError(
				'Each locale in the configuration file must have a "code" and a "name".',
			);
		}
		if (!LOCALE_CODE_PATTERN.test(locale.code) || locale.code === 'en' || codes.has(locale.code)) {
			throw new UsageError(`The locale code "${locale.code}" is not valid or is not unique.`);
		}
		if (locale.glossary !== undefined && !isPlainObject(locale.glossary)) {
			throw new UsageError(`The glossary of "${locale.code}" must be an object.`);
		}
		codes.add(locale.code);
	}
	for (const name of ['batchSize', 'maxBatchChars', 'concurrency', 'maxAttempts']) {
		if (!Number.isInteger(config[name]) || config[name] < 1) {
			throw new UsageError(`"${name}" in the configuration file must be a positive integer.`);
		}
	}
	if (
		config.optionalPlaceholders !== undefined &&
		!(
			Array.isArray(config.optionalPlaceholders) &&
			config.optionalPlaceholders.every((name) => typeof name === 'string' && name.trim() !== '')
		)
	) {
		throw new UsageError(
			'"optionalPlaceholders" in the configuration file must be an array of placeholder names.',
		);
	}
	if (config.requestOptions !== undefined && !isPlainObject(config.requestOptions)) {
		throw new UsageError('"requestOptions" in the configuration file must be an object.');
	}
	if (config.requestOptions?.stream !== undefined && config.requestOptions.stream !== false) {
		throw new UsageError(
			'"requestOptions.stream" in the configuration file is not supported. Each request asks for a JSON response without streaming.',
		);
	}
	if (config.apiFormat !== undefined && !API_FORMATS.includes(config.apiFormat)) {
		throw new UsageError(
			`"apiFormat" in the configuration file must be one of: ${API_FORMATS.join(', ')}.`,
		);
	}
	if (
		config.anthropicVersion !== undefined &&
		(typeof config.anthropicVersion !== 'string' || config.anthropicVersion.trim() === '')
	) {
		throw new UsageError(
			'"anthropicVersion" in the configuration file must be a non-empty string.',
		);
	}
	return config;
}

/** Parses the command line arguments. */
export function parseCliArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			options: {
				source: { type: 'string' },
				locale: { type: 'string' },
				'i18n-dir': { type: 'string' },
			},
			strict: true,
		});
	} catch (error) {
		throw new UsageError(error.message);
	}
	const { values } = parsed;
	if (!values.source || !values.locale) {
		throw new UsageError(
			'Usage: translate.mjs --source <en.json> --locale <code> [--i18n-dir <dir>]',
		);
	}
	return {
		source: values.source,
		locale: values.locale,
		i18nDir: values['i18n-dir'] ?? DEFAULT_I18N_DIR,
	};
}

/** Reads a JSON file, or returns an empty object when the file does not exist. */
export function readJsonIfExists(path) {
	if (!existsSync(path)) return {};
	try {
		const value = JSON.parse(readFileSync(path, 'utf8'));
		if (!isPlainObject(value)) throw new Error('the file is not a JSON object');
		return value;
	} catch (error) {
		throw new UsageError(`Cannot read ${path}: ${error.message}`);
	}
}

/** Returns the indentation that the first indented line of a JSON text uses. */
export function detectIndent(text) {
	return /^[{[]\r?\n([ \t]+)/.exec(text)?.[1] ?? '\t';
}

/** Writes a JSON file through a temporary file. */
export function writeJson(path, value, indent) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, indent)}\n`);
	renameSync(temporary, path);
}

/** Formats the Markdown summary of one locale run. */
export function formatSummary(locale, stats) {
	const coverage = stats.total === 0 ? 100 : (stats.translated / stats.total) * 100;
	return [
		`### UI translation: ${locale.code} (${locale.name})`,
		'',
		'| Metric | Value |',
		'| --- | ---: |',
		`| Total strings | ${stats.total} |`,
		`| Translated | ${stats.translated} |`,
		`| Added in this run | ${stats.added} |`,
		`| Corrected by a second request | ${stats.corrected} |`,
		`| Rejected by validation | ${stats.rejected} |`,
		`| Failed API requests (entries) | ${stats.failed} |`,
		`| Not attempted | ${stats.skipped} |`,
		`| Removed from upstream | ${stats.removed} |`,
		`| Existing translations without state, kept | ${stats.adopted} |`,
		`| Coverage | ${coverage.toFixed(1)}% |`,
		'',
		'',
	].join('\n');
}

/** Runs the command line program and returns its exit code. */
export async function main(argv, { env = process.env, ...overrides } = {}) {
	const deps = {
		fetch: globalThis.fetch,
		sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
		now: () => Date.now(),
		random: Math.random,
		log: (message) => process.stdout.write(`${message}\n`),
		...overrides,
	};

	let args;
	let config;
	let locale;
	let sourceText;
	let sourceMessages;
	let translations;
	let state;
	let paths;
	try {
		args = parseCliArgs(argv);
		config = loadConfig(join(args.i18nDir, 'config.json'));
		locale = config.locales.find((item) => item.code === args.locale);
		if (!locale)
			throw new UsageError(`The locale "${args.locale}" is not in the configuration file.`);
		try {
			sourceText = readFileSync(args.source, 'utf8');
			sourceMessages = JSON.parse(sourceText);
		} catch (error) {
			throw new UsageError(`Cannot read the source file ${args.source}: ${error.message}`);
		}
		if (!isPlainObject(sourceMessages))
			throw new UsageError('The source file is not a JSON object.');
		paths = {
			translations: join(args.i18nDir, 'locales', `${locale.code}.json`),
			state: join(args.i18nDir, 'state', `${locale.code}.json`),
		};
		translations = toValueMap(readJsonIfExists(paths.translations));
		state = toValueMap(readJsonIfExists(paths.state));
	} catch (error) {
		if (error instanceof UsageError) {
			deps.log(`::error::${error.message}`);
			return EXIT_USAGE;
		}
		throw error;
	}

	const indent = detectIndent(sourceText);
	const filesExisted = {
		translations: existsSync(paths.translations),
		state: existsSync(paths.state),
	};
	const save = (translationMap, stateMap) => {
		if (filesExisted.translations || translationMap.size > 0) {
			writeJson(paths.translations, buildOrdered(sourceMessages, translationMap), indent);
			filesExisted.translations = true;
		}
		if (filesExisted.state || stateMap.size > 0) {
			writeJson(paths.state, buildOrdered(sourceMessages, stateMap), indent);
			filesExisted.state = true;
		}
	};

	let lastCheckpoint = deps.now();
	const checkpoint = (translationMap, stateMap) => {
		if (deps.now() - lastCheckpoint < CHECKPOINT_INTERVAL_MS) return;
		lastCheckpoint = deps.now();
		save(translationMap, stateMap);
	};

	const api = {
		baseUrl: env.I18N_API_BASE_URL ?? '',
		model: env.I18N_MODEL ?? '',
		apiKey: env.I18N_API_KEY ?? '',
	};
	if (!api.baseUrl || !api.model || !api.apiKey) {
		const pruned = pruneRemoved(flattenMessages(sourceMessages), translations, state);
		save(pruned.translations, pruned.state);
		deps.log(
			`::warning::I18N_API_BASE_URL, I18N_MODEL, or I18N_API_KEY is not set. Only removed keys were deleted for ${locale.code} (${pruned.removed}).`,
		);
		return 0;
	}

	let concurrency = config.concurrency;
	if (env.I18N_CONCURRENCY) {
		concurrency = Number(env.I18N_CONCURRENCY);
		if (!Number.isInteger(concurrency) || concurrency < 1) {
			deps.log('::error::I18N_CONCURRENCY must be a positive integer.');
			return EXIT_USAGE;
		}
	}
	const settings = {
		batchSize: config.batchSize,
		maxBatchChars: config.maxBatchChars,
		maxAttempts: config.maxAttempts,
		concurrency,
		requestOptions: config.requestOptions ?? {},
		optionalPlaceholders: config.optionalPlaceholders ?? [],
		apiFormat: config.apiFormat ?? 'openai',
		anthropicVersion: config.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
		requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
	};
	const result = await translateLocale({
		sourceMessages,
		translations,
		state,
		locale,
		settings,
		api,
		deps,
		onCheckpoint: checkpoint,
	});
	save(result.translations, result.state);

	const { stats } = result;
	deps.log(
		`${locale.code}: ${stats.translated}/${stats.total} translated, ${stats.added} added, ${stats.corrected} corrected by a second request, ${stats.rejected} rejected, ${stats.failed} failed, ${stats.skipped} not attempted, ${stats.removed} removed, ${stats.adopted} kept without state.`,
	);
	if (env.GITHUB_STEP_SUMMARY)
		appendFileSync(env.GITHUB_STEP_SUMMARY, formatSummary(locale, stats));

	if (stats.fatalError) {
		deps.log(`::error::${stats.fatalError}`);
		return EXIT_FAILURE;
	}
	if (stats.batches > 0 && stats.successfulBatches === 0) {
		deps.log(`::error::No batch for ${locale.code} was translated.`);
		return EXIT_FAILURE;
	}
	const incomplete = stats.rejected + stats.failed + stats.skipped;
	if (incomplete > 0) {
		deps.log(
			`::warning::${incomplete} entries for ${locale.code} were not translated (${stats.rejected} rejected, ${stats.failed} failed, ${stats.skipped} not attempted). The next run tries them again.`,
		);
	}
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = await main(process.argv.slice(2));
}
