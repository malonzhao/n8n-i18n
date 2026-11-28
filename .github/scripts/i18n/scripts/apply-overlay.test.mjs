import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import vm from 'node:vm';

import {
	BOOT_IMPORT,
	ENTRY_SCRIPT_TAG,
	LOADER_IMPORT,
	OverlayError,
	applyOverlay,
	bootScriptTag,
	contentHash,
	loadMessageCompiler,
	main,
	removeUncompilable,
	renderBootScript,
	renderLocaleScript,
} from './apply-overlay.mjs';

/** Path of the script under test. */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'apply-overlay.mjs');

/** Root of the repository that contains this script, which may have the real compiler installed. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Page template of the editor in this repository, which a sparse checkout does not have. */
const EDITOR_INDEX_HTML = join(REPO_ROOT, 'packages/frontend/editor-ui/index.html');

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

/** Original content of the fixture page template. */
const INDEX_HTML = `<!DOCTYPE html>\n<html>\n\t<head></head>\n\t<body>\n\t\t<div id="app"></div>\n\t\t${ENTRY_SCRIPT_TAG}\n\t</body>\n</html>\n`;

/** Returns the fixture page template with the boot script tag of a content hash. */
const indexHtmlWithBoot = (hash) =>
	INDEX_HTML.replace(
		`\t\t${ENTRY_SCRIPT_TAG}`,
		`\t\t${bootScriptTag(hash)}\n\t\t${ENTRY_SCRIPT_TAG}`,
	);

/** Returns the number of boot script tags in a page template. */
const countBootTags = (html) => html.split('/static/i18n-overlay/boot.js').length - 1;

/** Fixture boot script template. */
const BOOT_TEMPLATE = 'var FILES = /*__I18N_OVERLAY_FILES__*/ {};\n';

/** Returns the messages that a generated locale script assigns, as objects of this realm. */
function runLocaleScript(content) {
	const context = vm.createContext({ JSON });
	context.window = { __n8nI18nOverlay: { messages: {} } };
	vm.runInContext(content, context);
	return context.window.__n8nI18nOverlay.messages;
}

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
		mkdirSync(join(repoRoot, 'packages/frontend/editor-ui/public/static'), { recursive: true });
		writeFileSync(join(repoRoot, 'packages/frontend/@n8n/i18n/src/locales/en.json'), '{"a":"A"}\n');
		writeFileSync(join(repoRoot, 'packages/frontend/editor-ui/src/main.ts'), MAIN_TS);
		writeFileSync(join(repoRoot, 'packages/frontend/editor-ui/index.html'), INDEX_HTML);
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
		writeFileSync(join(i18nDir, 'overlay', 'i18nBoot.js'), BOOT_TEMPLATE);
		writeFileSync(join(i18nDir, 'overlay', 'i18nLocaleBoot.ts'), 'export const boot = 1;\n');
		writeFileSync(join(i18nDir, 'overlay', 'i18nLocaleLoader.ts'), 'export {};\n');
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const staticDir = () => join(repoRoot, 'packages/frontend/editor-ui/public/static/i18n-overlay');
	const appDir = () => join(repoRoot, 'packages/frontend/editor-ui/src/app');
	const upstreamLocalesDir = () => join(repoRoot, 'packages/frontend/@n8n/i18n/src/locales');
	const mainPath = () => join(repoRoot, 'packages/frontend/editor-ui/src/main.ts');
	const indexHtmlPath = () => join(repoRoot, 'packages/frontend/editor-ui/index.html');
	const readStatic = (name) => readFileSync(join(staticDir(), name), 'utf8');
	const readMessages = (code) => runLocaleScript(readStatic(`${code}.js`))[code];
	const bootHash = () => contentHash(readStatic('boot.js'));

	it('writes valid listed locales and the boot script, installs the modules, and adds the imports', () => {
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
		assert.equal(result.bootImportAdded, true);
		assert.equal(result.scriptTagAdded, true);
		assert.deepEqual(readMessages('zh-CN'), { a: '甲' });
		assert.deepEqual(readdirSync(staticDir()).sort(), ['boot.js', 'zh-CN.js']);
		assert.equal(existsSync(join(appDir(), 'i18nLocales')), false);
		assert.equal(readFileSync(join(upstreamLocalesDir(), 'en.json'), 'utf8'), '{"a":"A"}\n');
		assert.equal(existsSync(join(upstreamLocalesDir(), 'zh-CN.json')), false);
		assert.equal(readFileSync(join(appDir(), 'i18nLocaleLoader.ts'), 'utf8'), 'export {};\n');
		assert.equal(
			readFileSync(join(appDir(), 'i18nLocaleBoot.ts'), 'utf8'),
			'export const boot = 1;\n',
		);
		assert.equal(readFileSync(mainPath(), 'utf8'), `${BOOT_IMPORT}\n${MAIN_TS}${LOADER_IMPORT}\n`);
		assert.equal(result.bootHash, bootHash());
		assert.equal(readFileSync(indexHtmlPath(), 'utf8'), indexHtmlWithBoot(bootHash()));
		assert.equal(logs.filter((line) => line.startsWith('::warning::')).length, 2);
	});

	it('writes locale scripts that restore the original messages', () => {
		const messages = {
			quote: 'a "b" \'c\' \\ d',
			lines: 'one\ntwo\r\n\tthree',
			unicode: '中文 😀 \u2028 \u2029 </script>',
			nested: { _designSystem: { 'nds.x': '{count} 項' } },
		};
		writeFileSync(join(i18nDir, 'locales', 'zh-CN.json'), JSON.stringify(messages));
		applyOverlay({ repoRoot, i18nDir, loadCompiler: () => acceptAll });
		const content = readStatic('zh-CN.js');
		assert.match(content, /^window\.__n8nI18nOverlay\.messages\["zh-CN"\] = JSON\.parse\("/);
		assert.equal(content.split('\n').length, 2);
		assert.deepEqual(readMessages('zh-CN'), messages);
	});

	it('writes the locale file table with content hashes into the boot script', () => {
		writeFileSync(join(i18nDir, 'locales', 'fr.json'), '{"a":"A fr"}');
		const result = applyOverlay({ repoRoot, i18nDir, loadCompiler: () => acceptAll });
		const expected = {
			'zh-CN': `zh-CN.js?v=${contentHash(readStatic('zh-CN.js'))}`,
			fr: `fr.js?v=${contentHash(readStatic('fr.js'))}`,
		};
		assert.deepEqual(result.files, expected);
		assert.match(expected.fr, /^fr\.js\?v=[0-9a-f]{12}$/);
		assert.notEqual(expected.fr.slice(-12), expected['zh-CN'].slice(-12));
		assert.equal(readStatic('boot.js'), `var FILES = ${JSON.stringify(expected)};\n`);
	});

	it('changes the hash when the messages change', () => {
		const first = applyOverlay({ repoRoot, i18nDir, loadCompiler: () => acceptAll });
		writeFileSync(join(i18nDir, 'locales', 'zh-CN.json'), '{"a":"乙"}');
		const second = applyOverlay({ repoRoot, i18nDir, loadCompiler: () => acceptAll });
		assert.notEqual(first.files['zh-CN'], second.files['zh-CN']);
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
		assert.deepEqual(readMessages('zh-CN'), { a: '好', _reusable: { d: '丁' } });
		const warning = logs.find((line) => line.includes('Removed 3 entries from zh-CN'));
		assert.ok(warning?.startsWith('::warning::'));
		assert.match(warning, /b \(bad message\); _reusable\.c \(bad message\); e\.f \(bad message\)/);
	});

	it('writes the files without a check when the compiler is not available', () => {
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
		assert.deepEqual(readMessages('zh-CN'), { a: 'BAD' });
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
			assert.deepEqual(Object.keys(readMessages('zh-CN')), [
				'literal',
				'link',
				'placeholder',
				'plural',
			]);
		},
	);

	it('is idempotent', () => {
		applyOverlay({ repoRoot, i18nDir });
		const second = applyOverlay({ repoRoot, i18nDir });
		assert.equal(second.importAdded, false);
		assert.equal(second.bootImportAdded, false);
		assert.equal(second.scriptTagAdded, false);
		const content = readFileSync(mainPath(), 'utf8');
		assert.equal(content.split(LOADER_IMPORT).length - 1, 1);
		assert.equal(content.split(BOOT_IMPORT).length - 1, 1);
		assert.equal(content, `${BOOT_IMPORT}\n${MAIN_TS}${LOADER_IMPORT}\n`);
		assert.equal(readFileSync(indexHtmlPath(), 'utf8'), indexHtmlWithBoot(bootHash()));
	});

	it('loads the boot script with the content hash of the boot script', () => {
		const result = applyOverlay({ repoRoot, i18nDir, loadCompiler: () => acceptAll });
		const hash = createHash('sha256').update(readStatic('boot.js')).digest('hex').slice(0, 12);
		assert.equal(result.bootHash, hash);
		assert.ok(readFileSync(indexHtmlPath(), 'utf8').includes(`boot.js?v=${hash}"`));
	});

	it('replaces the hash of the boot script tag when the messages change', () => {
		const first = applyOverlay({ repoRoot, i18nDir, loadCompiler: () => acceptAll });
		writeFileSync(join(i18nDir, 'locales', 'zh-CN.json'), '{"a":"乙"}');
		const second = applyOverlay({ repoRoot, i18nDir, loadCompiler: () => acceptAll });
		assert.notEqual(first.bootHash, second.bootHash);
		assert.equal(second.scriptTagAdded, true);
		const html = readFileSync(indexHtmlPath(), 'utf8');
		assert.equal(html, indexHtmlWithBoot(second.bootHash));
		assert.equal(countBootTags(html), 1);
	});

	it('does not change the page template when the boot script does not change', () => {
		applyOverlay({ repoRoot, i18nDir, loadCompiler: () => acceptAll });
		const before = readFileSync(indexHtmlPath(), 'utf8');
		const second = applyOverlay({ repoRoot, i18nDir, loadCompiler: () => acceptAll });
		assert.equal(second.scriptTagAdded, false);
		assert.equal(readFileSync(indexHtmlPath(), 'utf8'), before);
	});

	it('replaces a boot script tag without a hash', () => {
		writeFileSync(
			indexHtmlPath(),
			INDEX_HTML.replace(
				`\t\t${ENTRY_SCRIPT_TAG}`,
				`\t\t<script src="/{{BASE_PATH}}/static/i18n-overlay/boot.js" type="text/javascript"></script>\n\t\t${ENTRY_SCRIPT_TAG}`,
			),
		);
		const result = applyOverlay({ repoRoot, i18nDir, loadCompiler: () => acceptAll });
		assert.equal(result.scriptTagAdded, true);
		assert.equal(readFileSync(indexHtmlPath(), 'utf8'), indexHtmlWithBoot(result.bootHash));
	});

	it('keeps one boot script tag before the entry point when the template has misplaced tags', () => {
		const stale =
			'<script src="/{{BASE_PATH}}/static/i18n-overlay/boot.js?v=old" type="text/javascript"></script>';
		writeFileSync(
			indexHtmlPath(),
			INDEX_HTML.replace('<head></head>', `<head>${stale}</head>`).replace(
				'<div id="app"></div>',
				`<div id="app"></div>${stale}`,
			),
		);
		const result = applyOverlay({ repoRoot, i18nDir, loadCompiler: () => acceptAll });
		assert.equal(readFileSync(indexHtmlPath(), 'utf8'), indexHtmlWithBoot(result.bootHash));
	});

	it('adds a line break when the entry point does not end with one', () => {
		writeFileSync(mainPath(), 'const a = 1;');
		applyOverlay({ repoRoot, i18nDir });
		assert.equal(
			readFileSync(mainPath(), 'utf8'),
			`${BOOT_IMPORT}\nconst a = 1;\n${LOADER_IMPORT}\n`,
		);
	});

	it('installs the modules but not the boot script when there are no locale files', () => {
		rmSync(join(i18nDir, 'locales'), { recursive: true });
		const result = applyOverlay({ repoRoot, i18nDir });
		assert.deepEqual(result.copied, []);
		assert.deepEqual(result.files, {});
		assert.equal(result.scriptTagAdded, false);
		assert.ok(existsSync(join(appDir(), 'i18nLocaleLoader.ts')));
		assert.ok(existsSync(join(appDir(), 'i18nLocaleBoot.ts')));
		assert.equal(readFileSync(mainPath(), 'utf8'), `${BOOT_IMPORT}\n${MAIN_TS}${LOADER_IMPORT}\n`);
		assert.equal(existsSync(staticDir()), false);
		assert.equal(readFileSync(indexHtmlPath(), 'utf8'), INDEX_HTML);
	});

	it('fails without changes when the page template has no entry point tag', () => {
		writeFileSync(indexHtmlPath(), '<html><body></body></html>\n');
		assert.throws(
			() => applyOverlay({ repoRoot, i18nDir }),
			(error) => error instanceof OverlayError && /has no tag/.test(error.message),
		);
		assert.equal(existsSync(staticDir()), false);
		assert.equal(readFileSync(mainPath(), 'utf8'), MAIN_TS);
		assert.equal(existsSync(join(appDir(), 'i18nLocaleBoot.ts')), false);
	});

	it('fails without changes when the entry point tag is not after the head end tag', () => {
		for (const html of [
			`<html><head>${ENTRY_SCRIPT_TAG}</head><body></body></html>\n`,
			`<html><body>${ENTRY_SCRIPT_TAG}</body></html>\n`,
		]) {
			writeFileSync(indexHtmlPath(), html);
			assert.throws(
				() => applyOverlay({ repoRoot, i18nDir }),
				(error) => error instanceof OverlayError && /structure changed/.test(error.message),
			);
			assert.equal(readFileSync(indexHtmlPath(), 'utf8'), html);
		}
		assert.equal(existsSync(staticDir()), false);
		assert.equal(readFileSync(mainPath(), 'utf8'), MAIN_TS);
	});

	it('fails when the boot script template has no marker', () => {
		writeFileSync(join(i18nDir, 'overlay', 'i18nBoot.js'), 'var FILES = {};\n');
		assert.throws(() => applyOverlay({ repoRoot, i18nDir }), /no marker/);
		assert.equal(existsSync(staticDir()), false);
		assert.equal(readFileSync(indexHtmlPath(), 'utf8'), INDEX_HTML);
	});

	it('fails when a target path does not exist', () => {
		rmSync(indexHtmlPath());
		assert.throws(() => applyOverlay({ repoRoot, i18nDir }), /index\.html does not exist/);
		rmSync(join(i18nDir, 'overlay', 'i18nLocaleBoot.ts'));
		assert.throws(() => applyOverlay({ repoRoot, i18nDir }), /i18nLocaleBoot\.ts does not exist/);
		rmSync(mainPath());
		assert.throws(() => applyOverlay({ repoRoot, i18nDir }), OverlayError);
		rmSync(join(repoRoot, 'packages/frontend/editor-ui/src/app'), { recursive: true });
		assert.throws(() => applyOverlay({ repoRoot, i18nDir }), /does not exist/);
		assert.equal(existsSync(staticDir()), false);
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

describe('editor page template', () => {
	it(
		'has the entry point tag after the first head end tag',
		{ skip: !existsSync(EDITOR_INDEX_HTML) },
		() => {
			const html = readFileSync(EDITOR_INDEX_HTML, 'utf8');
			const entryIndex = html.indexOf(ENTRY_SCRIPT_TAG);
			const headEndIndex = html.indexOf('</head>');
			assert.notEqual(entryIndex, -1);
			assert.notEqual(headEndIndex, -1);
			assert.ok(entryIndex > headEndIndex);
		},
	);
});

describe('renderLocaleScript', () => {
	it('quotes the locale code', () => {
		const content = renderLocaleScript('a"b', { x: 'y' });
		assert.deepEqual(runLocaleScript(content), { 'a"b': { x: 'y' } });
	});
});

describe('renderBootScript', () => {
	it('replaces the marker with the locale file table', () => {
		assert.equal(
			renderBootScript('var FILES = /*__I18N_OVERLAY_FILES__*/{};', { fr: 'fr.js?v=$&' }),
			'var FILES = {"fr":"fr.js?v=$&"};',
		);
	});

	it('fails when the template has no marker', () => {
		assert.throws(() => renderBootScript('var FILES = {};', {}), OverlayError);
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
