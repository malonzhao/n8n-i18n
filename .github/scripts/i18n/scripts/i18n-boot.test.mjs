import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import vm from 'node:vm';

import { renderBootScript, renderLocaleScript } from './apply-overlay.mjs';

/** Source of the boot script template under test. */
const TEMPLATE = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '..', 'overlay', 'i18nBoot.js'),
	'utf8',
);

/** Local storage key of the last UI locale. */
const STORAGE_KEY = 'n8n:i18n-overlay-locale';

/** Locale file table of the rendered fixture boot script. */
const FILES = { 'zh-TW': 'zh-TW.js?v=0123456789ab', fr: 'fr.js?v=ba9876543210' };

/** Boot script with the fixture locale file table. */
const BOOT = renderBootScript(TEMPLATE, FILES);

/** Address of the boot script in the fixture page. */
const BOOT_SRC = 'https://n8n.example.com/base/static/i18n-overlay/boot.js';

/** Directory address of the boot script in the fixture page. */
const BASE = 'https://n8n.example.com/base/static/i18n-overlay/';

/** Runs a boot script in a fake browser and returns the window, the written HTML, and the warnings. */
function runBoot(
	source,
	{
		settings,
		stored = null,
		storage,
		currentScript = { src: BOOT_SRC, nonce: 'n0nce' },
		write,
	} = {},
) {
	const written = [];
	const warnings = [];
	const window = {
		localStorage: storage ?? {
			getItem: (key) => (key === STORAGE_KEY ? stored : null),
		},
	};
	if (settings !== undefined) window.__n8nSettings = settings;
	const document = {
		currentScript,
		write: write ?? ((html) => written.push(html)),
	};
	const context = vm.createContext({
		window,
		document,
		JSON,
		console: { warn: (...args) => warnings.push(args) },
	});
	vm.runInContext(source, context);
	return { window, written, warnings };
}

/** Returns a copy of a value from the fake browser realm as plain data of this realm. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Returns the script tag that the boot script writes for a locale file. */
const tag = (file, nonce = 'n0nce') =>
	`<script src="${BASE}${file}"${nonce ? ` nonce="${nonce}"` : ''}></script>`;

describe('i18nBoot', () => {
	it('runs as a template without changes and writes nothing', () => {
		const { window, written, warnings } = runBoot(TEMPLATE, {
			settings: { defaultLocale: 'zh-TW' },
		});
		assert.deepEqual(written, []);
		assert.deepEqual(warnings, []);
		assert.deepEqual(plain(window.__n8nI18nOverlay.files), {});
		assert.equal(window.__n8nI18nOverlay.locale, null);
	});

	it('uses the locale of the embedded settings', () => {
		const { window, written, warnings } = runBoot(BOOT, {
			settings: { defaultLocale: 'zh-TW' },
			stored: 'fr',
		});
		assert.deepEqual(written, [tag(FILES['zh-TW'])]);
		assert.deepEqual(warnings, []);
		const overlay = window.__n8nI18nOverlay;
		assert.equal(overlay.locale, 'zh-TW');
		assert.equal(overlay.base, BASE);
		assert.equal(overlay.nonce, 'n0nce');
		assert.deepEqual(plain(overlay.files), FILES);
		assert.deepEqual(plain(overlay.messages), {});
	});

	it('uses the stored locale when the embedded settings are missing or malformed', () => {
		for (const settings of [
			undefined,
			null,
			'zh-TW',
			{},
			{ defaultLocale: 3 },
			{ defaultLocale: '' },
		]) {
			const { window, written } = runBoot(BOOT, { settings, stored: 'fr' });
			assert.deepEqual(written, [tag(FILES.fr)], JSON.stringify(settings));
			assert.equal(window.__n8nI18nOverlay.locale, 'fr');
		}
	});

	it('writes nothing for English', () => {
		const { window, written } = runBoot(BOOT, { settings: { defaultLocale: 'en' }, stored: 'fr' });
		assert.deepEqual(written, []);
		assert.equal(window.__n8nI18nOverlay.locale, null);
		assert.deepEqual(runBoot(BOOT, { stored: 'en' }).written, []);
	});

	it('writes nothing when no locale is known', () => {
		assert.deepEqual(runBoot(BOOT).written, []);
		for (const locale of ['ko', 'toString', '__proto__', 'hasOwnProperty']) {
			const { window, written, warnings } = runBoot(BOOT, {
				settings: { defaultLocale: locale },
			});
			assert.deepEqual(written, [], locale);
			assert.deepEqual(warnings, [], locale);
			assert.equal(window.__n8nI18nOverlay.locale, null);
		}
	});

	it('adds the nonce of the boot script, and leaves it out when there is none', () => {
		const settings = { defaultLocale: 'zh-TW' };
		assert.deepEqual(runBoot(BOOT, { settings }).written, [tag(FILES['zh-TW'])]);
		const { written, window } = runBoot(BOOT, {
			settings,
			currentScript: { src: BOOT_SRC, nonce: '' },
		});
		assert.deepEqual(written, [tag(FILES['zh-TW'], '')]);
		assert.equal(window.__n8nI18nOverlay.nonce, '');
		assert.deepEqual(runBoot(BOOT, { settings, currentScript: { src: BOOT_SRC } }).written, [
			tag(FILES['zh-TW'], ''),
		]);
	});

	it('escapes the address and the nonce in the written tag', () => {
		const boot = renderBootScript(TEMPLATE, { fr: 'fr.js?a=1&b="2"' });
		const { written } = runBoot(boot, {
			settings: { defaultLocale: 'fr' },
			currentScript: { src: "https://h/x'<y>/boot.js", nonce: 'a"b&c' },
		});
		assert.deepEqual(written, [
			'<script src="https://h/x&#39;&lt;y&gt;/fr.js?a=1&amp;b=&quot;2&quot;" nonce="a&quot;b&amp;c"></script>',
		]);
	});

	it('does not fail when local storage throws', () => {
		const throwing = {
			getItem: () => {
				throw new Error('The storage is not available');
			},
		};
		const result = runBoot(BOOT, { storage: throwing });
		assert.deepEqual(result.written, []);
		assert.deepEqual(result.warnings, []);
		assert.equal(result.window.__n8nI18nOverlay.locale, null);
		const embedded = runBoot(BOOT, { storage: throwing, settings: { defaultLocale: 'fr' } });
		assert.deepEqual(embedded.written, [tag(FILES.fr)]);
	});

	it('writes nothing when the boot script has no address', () => {
		const { window, written, warnings } = runBoot(BOOT, {
			settings: { defaultLocale: 'fr' },
			currentScript: null,
		});
		assert.deepEqual(written, []);
		assert.deepEqual(warnings, []);
		assert.equal(window.__n8nI18nOverlay.base, '');
	});

	it('warns with the error when writing fails', () => {
		const error = new Error('write failed');
		const { warnings } = runBoot(BOOT, {
			settings: { defaultLocale: 'fr' },
			write: () => {
				throw error;
			},
		});
		assert.equal(warnings.length, 1);
		assert.equal(warnings[0][1], error);
	});

	it('lets the written locale script add its messages', () => {
		const messages = { 'settings.chatHub': '聊天', _designSystem: { 'nds.x': '{n} 項' } };
		const { window } = runBoot(BOOT, { settings: { defaultLocale: 'zh-TW' } });
		const context = vm.createContext({ window, JSON });
		vm.runInContext(renderLocaleScript('zh-TW', messages), context);
		assert.deepEqual(window.__n8nI18nOverlay.messages['zh-TW'], messages);
	});
});
