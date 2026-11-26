#!/usr/bin/env node
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** Default i18n directory, which is the parent of the scripts directory. */
const DEFAULT_I18N_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Import statement that activates the locale loader in the editor entry point. */
export const LOADER_IMPORT = "import '@/app/i18nLocaleLoader';";

/** Target paths in the n8n source tree, relative to the repository root. */
const TARGETS = {
	app: 'packages/frontend/editor-ui/src/app',
	locales: 'packages/frontend/editor-ui/src/app/i18nLocales',
	main: 'packages/frontend/editor-ui/src/main.ts',
};

/** Error for usage problems and missing paths. */
export class OverlayError extends Error {}

/** Returns true when the path is an existing directory. */
function isDirectory(path) {
	return existsSync(path) && statSync(path).isDirectory();
}

/** Returns the locale codes that the configuration file lists. */
function readLocaleCodes(configPath) {
	let config;
	try {
		config = JSON.parse(readFileSync(configPath, 'utf8'));
	} catch (error) {
		throw new OverlayError(`Cannot read the configuration file ${configPath}: ${error.message}`);
	}
	if (!Array.isArray(config?.locales)) {
		throw new OverlayError(`The configuration file ${configPath} has no "locales" array.`);
	}
	return config.locales
		.map((locale) => locale?.code)
		.filter((code) => typeof code === 'string' && /^[A-Za-z0-9-]+$/.test(code) && code !== 'en');
}

/** Number of removed keys that the warning of one locale lists. */
const LISTED_REMOVED_KEYS = 10;

/** Returns a function that compiles one message with the vue-i18n compiler of the source tree and returns its errors, or null when it compiles. */
export function loadMessageCompiler(repoRoot) {
	const fromI18n = createRequire(join(repoRoot, 'packages/frontend/@n8n/i18n/package.json'));
	const fromVueI18n = createRequire(fromI18n.resolve('vue-i18n/package.json'));
	const fromCoreBase = createRequire(fromVueI18n.resolve('@intlify/core-base/package.json'));
	const { baseCompile } = fromCoreBase('@intlify/message-compiler');
	if (typeof baseCompile !== 'function') {
		throw new Error('@intlify/message-compiler does not export baseCompile');
	}
	return (message) => {
		const errors = [];
		try {
			baseCompile(message, { onError: (error) => errors.push(error.message) });
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
		return errors.length > 0 ? errors.join('; ') : null;
	};
}

/** Returns a copy of nested messages without the string leaves that the compiler rejects, and the removed keys. */
export function removeUncompilable(messages, compile, prefix = []) {
	const kept = {};
	const removed = [];
	for (const [name, value] of Object.entries(messages)) {
		const path = [...prefix, name];
		if (typeof value === 'string') {
			const error = compile(value);
			if (error) removed.push({ key: path.join('.'), error });
			else kept[name] = value;
		} else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			const child = removeUncompilable(value, compile, path);
			removed.push(...child.removed);
			if (Object.keys(child.kept).length > 0) kept[name] = child.kept;
		} else {
			removed.push({ key: path.join('.'), error: 'the value is not a string' });
		}
	}
	return { kept, removed };
}

/** Returns the indentation that the first indented line of a JSON text uses. */
function detectIndent(text) {
	return /^[{[]\r?\n([ \t]+)/.exec(text)?.[1] ?? '\t';
}

/** Copies the locale files and the loader into an n8n source tree and returns what it did. */
export function applyOverlay({
	repoRoot,
	i18nDir = DEFAULT_I18N_DIR,
	log = () => {},
	loadCompiler = loadMessageCompiler,
}) {
	const root = resolve(repoRoot);
	const localesDir = join(root, TARGETS.locales);
	const appDir = join(root, TARGETS.app);
	const mainPath = join(root, TARGETS.main);
	const loaderSource = join(i18nDir, 'overlay', 'i18nLocaleLoader.ts');

	for (const [path, check] of [
		[appDir, isDirectory],
		[mainPath, existsSync],
		[loaderSource, existsSync],
	]) {
		if (!check(path)) throw new OverlayError(`The path ${path} does not exist.`);
	}
	mkdirSync(localesDir, { recursive: true });

	let compile = null;
	try {
		compile = loadCompiler(root);
	} catch (error) {
		log(
			`::warning::The vue-i18n message compiler is not available, so the locale files are copied without a compile check: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const copied = [];
	const removedByLocale = {};
	const skipped = [];
	for (const code of readLocaleCodes(join(i18nDir, 'config.json'))) {
		const sourcePath = join(i18nDir, 'locales', `${code}.json`);
		if (!existsSync(sourcePath)) {
			skipped.push(code);
			continue;
		}
		const text = readFileSync(sourcePath, 'utf8');
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			log(`::warning::Skipped ${sourcePath} because it is not valid JSON: ${error.message}`);
			skipped.push(code);
			continue;
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			log(`::warning::Skipped ${sourcePath} because it is not a JSON object.`);
			skipped.push(code);
			continue;
		}
		const targetPath = join(localesDir, `${code}.json`);
		const { kept, removed } = compile
			? removeUncompilable(parsed, compile)
			: { kept: parsed, removed: [] };
		if (removed.length > 0) {
			const listed = removed
				.slice(0, LISTED_REMOVED_KEYS)
				.map((item) => `${item.key} (${item.error})`)
				.join('; ');
			log(
				`::warning::Removed ${removed.length} entries from ${code} because vue-i18n cannot compile them: ${listed}${removed.length > LISTED_REMOVED_KEYS ? '; …' : ''}`,
			);
			writeFileSync(targetPath, `${JSON.stringify(kept, null, detectIndent(text))}\n`);
		} else {
			writeFileSync(targetPath, text);
		}
		removedByLocale[code] = removed.map((item) => item.key);
		copied.push(code);
	}

	copyFileSync(loaderSource, join(appDir, 'i18nLocaleLoader.ts'));

	const main = readFileSync(mainPath, 'utf8');
	const hasImport = main.split(/\r?\n/).some((line) => line.trim() === LOADER_IMPORT);
	if (!hasImport) {
		const separator = main.length === 0 || main.endsWith('\n') ? '' : '\n';
		writeFileSync(mainPath, `${main}${separator}${LOADER_IMPORT}\n`);
	}

	log(
		`Copied locales: ${copied.length > 0 ? copied.join(', ') : 'none (no locale files found, so the UI stays in English)'}. Installed the locale loader${hasImport ? ' (the import was already present)' : ''}.`,
	);
	return {
		copied,
		skipped,
		importAdded: !hasImport,
		compileChecked: compile !== null,
		removedByLocale,
	};
}

/** Runs the command line program and returns its exit code. */
export function main(argv, { log = (message) => process.stdout.write(`${message}\n`) } = {}) {
	try {
		let values;
		try {
			({ values } = parseArgs({
				args: argv,
				options: { 'repo-root': { type: 'string' }, 'i18n-dir': { type: 'string' } },
				strict: true,
			}));
		} catch (error) {
			throw new OverlayError(error.message);
		}
		if (!values['repo-root']) {
			throw new OverlayError('Usage: apply-overlay.mjs --repo-root <n8n source root>');
		}
		applyOverlay({
			repoRoot: values['repo-root'],
			i18nDir: values['i18n-dir'] ?? DEFAULT_I18N_DIR,
			log,
		});
		return 0;
	} catch (error) {
		if (!(error instanceof OverlayError)) throw error;
		log(`::error::${error.message}`);
		return 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = main(process.argv.slice(2));
}
