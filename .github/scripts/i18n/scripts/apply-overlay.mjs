#!/usr/bin/env node
import { createHash } from 'node:crypto';
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

/** Import statement that activates the locale loader at the end of the editor entry point. */
export const LOADER_IMPORT = "import '@/app/i18nLocaleLoader';";

/** Import statement that applies the boot locale at the start of the editor entry point. */
export const BOOT_IMPORT = "import '@/app/i18nLocaleBoot';";

/** Script tag of the editor entry point in the page template, before which the boot script goes. */
export const ENTRY_SCRIPT_TAG = '<script type="module" src="/src/main.ts"></script>';

/** End tag of the page head, before which the server embeds the settings script. */
const HEAD_END_TAG = '</head>';

/** Pattern of a script tag that loads the boot script, with or without a content hash. */
const BOOT_SCRIPT_TAG_PATTERN =
	/<script\b[^>]*\bsrc="[^"]*\/static\/i18n-overlay\/boot\.js(?:\?[^"]*)?"[^>]*><\/script>/g;

/** Returns the script tag that loads the boot script with a content hash from the static files. */
export function bootScriptTag(hash) {
	return `<script src="/{{BASE_PATH}}/static/i18n-overlay/boot.js?v=${hash}" type="text/javascript"></script>`;
}

/** Pattern of the marker in the boot script template that the locale file table replaces. */
const FILES_MARKER = /\/\*__I18N_OVERLAY_FILES__\*\/\s*\{\}/;

/** Number of hexadecimal characters of the content hash in the locale file URLs. */
const HASH_LENGTH = 12;

/** Target paths in the n8n source tree, relative to the repository root. */
const TARGETS = {
	app: 'packages/frontend/editor-ui/src/app',
	main: 'packages/frontend/editor-ui/src/main.ts',
	indexHtml: 'packages/frontend/editor-ui/index.html',
	static: 'packages/frontend/editor-ui/public/static/i18n-overlay',
};

/** Overlay source files that are copied into the app directory. */
const APP_FILES = ['i18nLocaleBoot.ts', 'i18nLocaleLoader.ts'];

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

/** Returns the first hexadecimal characters of the SHA-256 hash of a text. */
export function contentHash(text) {
	return createHash('sha256').update(text).digest('hex').slice(0, HASH_LENGTH);
}

/** Returns the static script that adds the messages of one locale to the overlay state. */
export function renderLocaleScript(code, messages) {
	return `window.__n8nI18nOverlay.messages[${JSON.stringify(code)}] = JSON.parse(${JSON.stringify(JSON.stringify(messages))});\n`;
}

/** Returns the boot script template with the marker replaced by the locale file table. */
export function renderBootScript(template, files) {
	if (!FILES_MARKER.test(template)) {
		throw new OverlayError('The boot script template has no marker for the locale file table.');
	}
	return template.replace(FILES_MARKER, () => JSON.stringify(files));
}

/** Returns the entry point with the boot import as the first line, or null when the import is already present. */
function addBootImport(main) {
	if (main.split(/\r?\n/).some((line) => line.trim() === BOOT_IMPORT)) return null;
	return `${BOOT_IMPORT}\n${main}`;
}

/** Returns the entry point with the loader import as the last line, or null when the import is already present. */
function addLoaderImport(main) {
	if (main.split(/\r?\n/).some((line) => line.trim() === LOADER_IMPORT)) return null;
	const separator = main.length === 0 || main.endsWith('\n') ? '' : '\n';
	return `${main}${separator}${LOADER_IMPORT}\n`;
}

/** Returns the page template with one boot script tag between the head end tag and the entry point tag, or null when the template already has it. */
function setBootScriptTag(html, path, tag) {
	const entryIndex = html.indexOf(ENTRY_SCRIPT_TAG);
	if (entryIndex === -1) {
		throw new OverlayError(`The page template ${path} has no tag ${ENTRY_SCRIPT_TAG}.`);
	}
	const headEndIndex = html.indexOf(HEAD_END_TAG);
	if (headEndIndex === -1 || entryIndex < headEndIndex) {
		throw new OverlayError(
			`The page template ${path} does not have the tag ${ENTRY_SCRIPT_TAG} after the first ${HEAD_END_TAG}, so its structure changed.`,
		);
	}
	const existing = [...html.matchAll(BOOT_SCRIPT_TAG_PATTERN)];
	if (existing.length === 1) {
		const [match] = existing;
		if (match.index > headEndIndex && match.index < entryIndex) {
			if (match[0] === tag) return null;
			return `${html.slice(0, match.index)}${tag}${html.slice(match.index + match[0].length)}`;
		}
	}
	const lines = html.split('\n').flatMap((line) => {
		const rest = line.replace(BOOT_SCRIPT_TAG_PATTERN, '');
		if (rest === line) return [line];
		return rest.trim() === '' ? [] : [rest];
	});
	const index = lines.findIndex((line) => line.includes(ENTRY_SCRIPT_TAG));
	const indent = /^[ \t]*/.exec(lines[index])[0];
	lines.splice(index, 0, `${indent}${tag}`);
	return lines.join('\n');
}

/** Reads one locale file and returns its messages, or null when it cannot be used. */
function readLocaleMessages(sourcePath, log) {
	if (!existsSync(sourcePath)) return null;
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(sourcePath, 'utf8'));
	} catch (error) {
		log(`::warning::Skipped ${sourcePath} because it is not valid JSON: ${error.message}`);
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		log(`::warning::Skipped ${sourcePath} because it is not a JSON object.`);
		return null;
	}
	return parsed;
}

/** Writes the locale scripts, the boot script, and the editor modules into an n8n source tree and returns what it did. */
export function applyOverlay({
	repoRoot,
	i18nDir = DEFAULT_I18N_DIR,
	log = () => {},
	loadCompiler = loadMessageCompiler,
}) {
	const root = resolve(repoRoot);
	const appDir = join(root, TARGETS.app);
	const mainPath = join(root, TARGETS.main);
	const indexHtmlPath = join(root, TARGETS.indexHtml);
	const staticDir = join(root, TARGETS.static);
	const overlayDir = join(i18nDir, 'overlay');
	const bootTemplatePath = join(overlayDir, 'i18nBoot.js');

	for (const [path, check] of [
		[appDir, isDirectory],
		[mainPath, existsSync],
		[bootTemplatePath, existsSync],
		...APP_FILES.map((name) => [join(overlayDir, name), existsSync]),
	]) {
		if (!check(path)) throw new OverlayError(`The path ${path} does not exist.`);
	}

	let compile = null;
	try {
		compile = loadCompiler(root);
	} catch (error) {
		log(
			`::warning::The vue-i18n message compiler is not available, so the locale files are copied without a compile check: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const scripts = [];
	const removedByLocale = {};
	const skipped = [];
	for (const code of readLocaleCodes(join(i18nDir, 'config.json'))) {
		const parsed = readLocaleMessages(join(i18nDir, 'locales', `${code}.json`), log);
		if (parsed === null) {
			skipped.push(code);
			continue;
		}
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
		}
		removedByLocale[code] = removed.map((item) => item.key);
		scripts.push({ code, content: renderLocaleScript(code, kept) });
	}
	const copied = scripts.map((script) => script.code);
	const files = Object.fromEntries(
		scripts.map(({ code, content }) => [code, `${code}.js?v=${contentHash(content)}`]),
	);

	let html = null;
	let bootHash = null;
	if (scripts.length > 0) {
		if (!existsSync(indexHtmlPath)) {
			throw new OverlayError(`The path ${indexHtmlPath} does not exist.`);
		}
		const bootScript = renderBootScript(readFileSync(bootTemplatePath, 'utf8'), files);
		bootHash = contentHash(bootScript);
		html = setBootScriptTag(
			readFileSync(indexHtmlPath, 'utf8'),
			indexHtmlPath,
			bootScriptTag(bootHash),
		);
		mkdirSync(staticDir, { recursive: true });
		for (const { code, content } of scripts) {
			writeFileSync(join(staticDir, `${code}.js`), content);
		}
		writeFileSync(join(staticDir, 'boot.js'), bootScript);
		if (html !== null) writeFileSync(indexHtmlPath, html);
	}

	for (const name of APP_FILES) {
		copyFileSync(join(overlayDir, name), join(appDir, name));
	}

	let main = readFileSync(mainPath, 'utf8');
	const withBoot = addBootImport(main);
	if (withBoot !== null) main = withBoot;
	const withLoader = addLoaderImport(main);
	if (withLoader !== null) main = withLoader;
	if (withBoot !== null || withLoader !== null) writeFileSync(mainPath, main);

	log(
		`Copied locales: ${copied.length > 0 ? copied.join(', ') : 'none (no locale files found, so the UI stays in English)'}. Installed the locale modules${withBoot === null && withLoader === null ? ' (the imports were already present)' : ''}${scripts.length > 0 ? `, the boot script ${bootHash}${html === null ? ' (the script tag was already up to date)' : ' (the script tag was updated)'}` : ''}.`,
	);
	return {
		copied,
		skipped,
		importAdded: withLoader !== null,
		bootImportAdded: withBoot !== null,
		scriptTagAdded: html !== null,
		bootHash,
		files,
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
