#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { UsageError, detectIndent, isPlainObject, writeJson } from './translate.mjs';

/** Exit code for usage and input file errors. */
const EXIT_USAGE = 2;

/** Top-level key of the design system messages in the translation source. */
export const DESIGN_SYSTEM_KEY = '_designSystem';

/** Argument that shows if a function without declared parameters uses its arguments. */
const ARGUMENT_PROBE = 2;

/** English templates and sample arguments for the design system messages that are functions with parameters. */
export const TEMPLATES = {
	'formInput.validator.oneNumbersRequired': {
		template: 'Must have at least {minimum} numbers',
		sample: { minimum: 2 },
	},
	'formInput.validator.uppercaseCharsRequired': {
		template: 'Must have at least {minimum} uppercase characters',
		sample: { minimum: 2 },
	},
	'tags.showMore': {
		template: '+{0} more',
		sample: [5],
	},
};

/** Returns a template with its {name} placeholders replaced by the values of the sample arguments. */
export function renderTemplate(template, sample) {
	return template.replace(/\{([0-9A-Za-z_]+)\}/g, (match, name) =>
		Object.hasOwn(sample, name) ? String(sample[name]) : match,
	);
}

/** Calls a message function with sample arguments, as one object or as a list of parameters. */
function callWithSample(fn, sample) {
	return Array.isArray(sample) ? fn(...sample) : fn(sample);
}

/** Returns the string source of one design system message, or the reason why it has no string source. */
function convertMessage(key, value, templates) {
	if (typeof value === 'string') return { value };
	if (typeof value !== 'function') return { reason: 'it is not a string or a function' };
	const entry = Object.hasOwn(templates, key) ? templates[key] : undefined;
	let result;
	let probed;
	try {
		if (entry) {
			result = callWithSample(value, entry.sample);
		} else if (value.length === 0) {
			result = value();
			probed = value(ARGUMENT_PROBE);
		}
	} catch (error) {
		return {
			reason: `the function failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (entry) {
		const expected = renderTemplate(entry.template, entry.sample);
		if (result !== expected) {
			return {
				reason: `the function returns "${String(result)}" for the sample arguments, but the template gives "${expected}"`,
			};
		}
		return { value: entry.template };
	}
	if (value.length > 0) return { reason: 'it is a function with parameters and has no template' };
	if (typeof result !== 'string') return { reason: 'the function does not return a string' };
	if (probed !== result) return { reason: 'the function uses its arguments and has no template' };
	return { value: result };
}

/** Converts the design system messages to strings, and returns them with warnings for the skipped entries. */
export function convertDesignSystemMessages(messages, templates = TEMPLATES) {
	const converted = {};
	const warnings = [];
	for (const [key, value] of Object.entries(messages)) {
		const { value: text, reason } = convertMessage(key, value, templates);
		if (reason) {
			warnings.push(
				`Skipped the design system message "${key}" because ${reason}. The UI shows it in English.`,
			);
		} else {
			converted[key] = text;
		}
	}
	return { converted, warnings };
}

/** Returns the translation source that adds the design system messages to the editor messages, and the warnings. */
export function buildSource(sourceMessages, designSystemMessages, templates = TEMPLATES) {
	if (Object.hasOwn(sourceMessages, DESIGN_SYSTEM_KEY)) {
		throw new UsageError(`The editor messages already have the key "${DESIGN_SYSTEM_KEY}".`);
	}
	const { converted, warnings } = convertDesignSystemMessages(designSystemMessages, templates);
	const count = Object.keys(converted).length;
	if (count === 0) throw new UsageError('The design system messages have no string entries.');
	return { messages: { ...sourceMessages, [DESIGN_SYSTEM_KEY]: converted }, warnings, count };
}

/** Imports the design system message module and returns its default export. */
export async function loadDesignSystemMessages(path) {
	let module;
	try {
		module = await import(pathToFileURL(resolve(path)).href);
	} catch (error) {
		throw new UsageError(
			`Cannot import the design system messages ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isPlainObject(module.default)) {
		throw new UsageError(`The default export of ${path} is not a plain object.`);
	}
	return module.default;
}

/** Runs the command line program and returns its exit code. */
export async function main(argv, { log = (message) => process.stdout.write(`${message}\n`) } = {}) {
	try {
		let values;
		try {
			({ values } = parseArgs({
				args: argv,
				options: {
					messages: { type: 'string' },
					'design-system': { type: 'string' },
					output: { type: 'string' },
				},
				strict: true,
			}));
		} catch (error) {
			throw new UsageError(error.message);
		}
		if (!values.messages || !values['design-system'] || !values.output) {
			throw new UsageError(
				'Usage: build-source.mjs --messages <en.json> --design-system <en.ts> --output <file>',
			);
		}
		let sourceText;
		let sourceMessages;
		try {
			sourceText = readFileSync(values.messages, 'utf8');
			sourceMessages = JSON.parse(sourceText);
		} catch (error) {
			throw new UsageError(`Cannot read the messages file ${values.messages}: ${error.message}`);
		}
		if (!isPlainObject(sourceMessages)) {
			throw new UsageError(`The messages file ${values.messages} is not a JSON object.`);
		}
		const designSystemMessages = await loadDesignSystemMessages(values['design-system']);
		const { messages, warnings, count } = buildSource(sourceMessages, designSystemMessages);
		for (const warning of warnings) log(`::warning::${warning}`);
		writeJson(values.output, messages, detectIndent(sourceText));
		log(
			`Wrote ${values.output} with ${count} design system messages (${warnings.length} skipped).`,
		);
		return 0;
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		log(`::error::${error.message}`);
		return EXIT_USAGE;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = await main(process.argv.slice(2));
}
