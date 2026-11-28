#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
	DEFAULT_I18N_DIR,
	UsageError,
	buildOrdered,
	detectIndent,
	flattenMessages,
	isPlainObject,
	loadConfig,
	readJsonIfExists,
	toValueMap,
	writeJson,
} from './translate.mjs';

/** Exit code for usage, configuration, and input file errors. */
const EXIT_USAGE = 2;

/** Merges the translation and state maps of one locale key by key, and keeps entries that changed on master during the run. */
export function mergeLocale({ master, base, result }) {
	const ids = new Set([
		...master.translations.keys(),
		...master.state.keys(),
		...base.translations.keys(),
		...base.state.keys(),
		...result.translations.keys(),
		...result.state.keys(),
	]);
	const translations = new Map();
	const state = new Map();
	let keptFromMaster = 0;
	for (const id of ids) {
		const masterChanged =
			master.translations.get(id) !== base.translations.get(id) ||
			master.state.get(id) !== base.state.get(id);
		const chosen = masterChanged ? master : result;
		if (
			masterChanged &&
			(master.translations.get(id) !== result.translations.get(id) ||
				master.state.get(id) !== result.state.get(id))
		) {
			keptFromMaster++;
		}
		if (chosen.translations.has(id)) translations.set(id, chosen.translations.get(id));
		if (chosen.state.has(id)) state.set(id, chosen.state.get(id));
	}
	return { translations, state, keptFromMaster };
}

/** Sets a value at a path in a nested object, unless a string already occupies part of the path. */
function setPath(target, path, value) {
	let node = target;
	for (const name of path.slice(0, -1)) {
		if (node[name] === undefined) node[name] = {};
		if (!isPlainObject(node[name])) return;
		node = node[name];
	}
	const last = path[path.length - 1];
	if (node[last] === undefined) node[last] = value;
}

/** Builds a nested object in source order, and appends the entries that the source does not have. */
export function buildOrderedWithExtras(source, values) {
	const result = buildOrdered(source, values);
	const sourceIds = new Set(flattenMessages(source).map((entry) => entry.id));
	for (const [id, value] of values) {
		if (!sourceIds.has(id)) setPath(result, JSON.parse(id), value);
	}
	return result;
}

/** Reads the translation and state maps of one locale from a directory with `locales` and `state` subdirectories. */
function readLocaleMaps(dir, code) {
	return {
		translations: toValueMap(readJsonIfExists(join(dir, 'locales', `${code}.json`))),
		state: toValueMap(readJsonIfExists(join(dir, 'state', `${code}.json`))),
	};
}

/** Merges the downloaded results of every configured locale into the i18n directory and returns per-locale statistics. */
export function mergeResults({ sourceMessages, indent, resultsDir, i18nDir, log = () => {} }) {
	const config = loadConfig(join(i18nDir, 'config.json'));
	const summary = [];
	for (const { code } of config.locales) {
		const resultFiles = ['locales', 'state'].map((kind) => join(resultsDir, kind, `${code}.json`));
		if (!resultFiles.some((path) => existsSync(path))) {
			log(`${code}: no results, skipped.`);
			continue;
		}
		const merged = mergeLocale({
			master: readLocaleMaps(i18nDir, code),
			base: readLocaleMaps(join(resultsDir, 'base'), code),
			result: readLocaleMaps(resultsDir, code),
		});
		for (const [kind, values] of [
			['locales', merged.translations],
			['state', merged.state],
		]) {
			const target = join(i18nDir, kind, `${code}.json`);
			if (existsSync(target) || values.size > 0) {
				writeJson(target, buildOrderedWithExtras(sourceMessages, values), indent);
			}
		}
		log(
			`${code}: ${merged.translations.size} translations, ${merged.keptFromMaster} entries kept from master.`,
		);
		summary.push({
			code,
			translations: merged.translations.size,
			keptFromMaster: merged.keptFromMaster,
		});
	}
	return summary;
}

/** Runs the command line program and returns its exit code. */
export function main(argv, { log = (message) => process.stdout.write(`${message}\n`) } = {}) {
	try {
		let values;
		try {
			({ values } = parseArgs({
				args: argv,
				options: {
					source: { type: 'string' },
					'results-dir': { type: 'string' },
					'i18n-dir': { type: 'string' },
				},
				strict: true,
			}));
		} catch (error) {
			throw new UsageError(error.message);
		}
		if (!values.source || !values['results-dir']) {
			throw new UsageError(
				'Usage: merge-results.mjs --source <en.json> --results-dir <dir> [--i18n-dir <dir>]',
			);
		}
		let sourceText;
		let sourceMessages;
		try {
			sourceText = readFileSync(values.source, 'utf8');
			sourceMessages = JSON.parse(sourceText);
		} catch (error) {
			throw new UsageError(`Cannot read the source file ${values.source}: ${error.message}`);
		}
		if (!isPlainObject(sourceMessages))
			throw new UsageError('The source file is not a JSON object.');
		mergeResults({
			sourceMessages,
			indent: detectIndent(sourceText),
			resultsDir: values['results-dir'],
			i18nDir: values['i18n-dir'] ?? DEFAULT_I18N_DIR,
			log,
		});
		return 0;
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		log(`::error::${error.message}`);
		return EXIT_USAGE;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = main(process.argv.slice(2));
}
