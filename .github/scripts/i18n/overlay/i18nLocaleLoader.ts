import { shallowRef, watch } from 'vue';
import { locale as designSystemLocale } from '@n8n/design-system';
import { i18n, i18nInstance } from '@n8n/i18n';
import { isRecord } from '@n8n/utils/is-record';

import type { I18nOverlay } from './i18nLocaleBoot';

/** Locale that the i18n package bundles by default. */
const DEFAULT_LOCALE = 'en';

/** Top-level key of the design system messages in the locale files. */
const DESIGN_SYSTEM_KEY = '_designSystem';

/** Local storage key of the last UI locale, which the boot script reads at startup. */
const STORAGE_KEY = 'n8n:i18n-overlay-locale';

/** Loads that are complete or in progress, keyed by locale code. */
const loads = new Map<string, Promise<void>>();

/** Design system messages of the loaded locales, keyed by locale code. */
const designSystemMessages = shallowRef<Record<string, Record<string, unknown>>>({});

/** Whether the warning about the missing overlay state was already shown. */
let missingOverlayWarned = false;

/** Stores the design system messages of a locale. */
function storeDesignSystemMessages(locale: string, messages: Record<string, unknown>): void {
	const designSystem = messages[DESIGN_SYSTEM_KEY];
	if (isRecord(designSystem)) {
		designSystemMessages.value = { ...designSystemMessages.value, [locale]: designSystem };
	}
}

/** Loads a static script file and resolves when it ran. */
async function loadScript(src: string, nonce: string): Promise<void> {
	return await new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = src;
		if (nonce) script.nonce = nonce;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error(`Could not load the script ${src}.`));
		document.head.appendChild(script);
	});
}

/** Returns the loaded messages of a locale from the overlay state, or undefined. */
function overlayMessages(
	overlay: I18nOverlay,
	locale: string,
): Record<string, unknown> | undefined {
	if (!isRecord(overlay.messages)) return undefined;
	const messages = overlay.messages[locale];
	return isRecord(messages) ? messages : undefined;
}

/** Returns the locale file name of a locale from the overlay state, or undefined. */
function overlayFile(overlay: I18nOverlay, locale: string): string | undefined {
	if (!isRecord(overlay.files)) return undefined;
	const file = overlay.files[locale];
	return typeof file === 'string' ? file : undefined;
}

/** Returns the messages of a locale from the overlay state, and loads its locale file first when necessary. */
async function readOverlayMessages(
	overlay: I18nOverlay,
	locale: string,
): Promise<Record<string, unknown>> {
	if (!overlayMessages(overlay, locale)) {
		const file = overlayFile(overlay, locale);
		if (file === undefined) throw new Error(`The locale "${locale}" has no locale file.`);
		await loadScript(`${overlay.base}${file}`, overlay.nonce);
	}
	const messages = overlayMessages(overlay, locale);
	if (!messages) throw new Error(`The locale file of "${locale}" has no messages.`);
	return messages;
}

/** Warns one time that the boot script did not run, so the UI stays in English. */
function warnMissingOverlay(): void {
	if (missingOverlayWarned) return;
	missingOverlayWarned = true;
	console.warn(
		'The boot script of the UI translations did not run, so the UI stays in English. Make sure that the server serves /static/i18n-overlay/.',
	);
}

/** Loads the messages of a locale once, merges them into the i18n instance, and stores its design system messages. */
async function loadLocale(locale: string): Promise<void> {
	const overlay = window.__n8nI18nOverlay;
	if (!overlay) {
		warnMissingOverlay();
		return;
	}
	if (!overlayMessages(overlay, locale) && overlayFile(overlay, locale) === undefined) return;
	const existing = loads.get(locale);
	if (existing) return await existing;
	const load = readOverlayMessages(overlay, locale)
		.then((messages) => {
			i18nInstance.global.mergeLocaleMessage(locale, messages);
			storeDesignSystemMessages(locale, messages);
			i18n.clearCache();
		})
		.catch((error: unknown) => {
			loads.delete(locale);
			console.warn(`Could not load the UI messages for locale "${locale}".`, error);
		});
	loads.set(locale, load);
	return await load;
}

/** Records the locale that the boot module applied, so that its messages are not merged again. */
function registerBootLocale(): void {
	const overlay = window.__n8nI18nOverlay;
	const locale = overlay?.locale;
	if (!overlay || typeof locale !== 'string') return;
	if (i18nInstance.global.locale.value !== locale) return;
	const messages = overlayMessages(overlay, locale);
	if (!messages) return;
	storeDesignSystemMessages(locale, messages);
	loads.set(locale, Promise.resolve());
}

/** Writes the current UI locale to local storage. */
function storeLocale(locale: string): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, locale);
	} catch (error) {
		console.warn('Could not store the UI locale.', error);
	}
}

/** Translates a design system message with the loaded messages of the UI locale, or returns the path to show the English text. */
function translateDesignSystem(path: string, options?: string[] | Record<string, unknown>): string {
	const message = designSystemMessages.value[i18nInstance.global.locale.value]?.[path];
	if (typeof message !== 'string') return path;
	return Array.isArray(options)
		? i18nInstance.global.rt(message, options)
		: i18nInstance.global.rt(message, options ?? {});
}

designSystemLocale.i18n(translateDesignSystem);

try {
	registerBootLocale();
} catch (error) {
	console.warn('Could not register the UI locale of the boot script.', error);
}

watch(
	() => i18nInstance.global.locale.value,
	(locale) => {
		storeLocale(locale);
		if (locale !== DEFAULT_LOCALE) void loadLocale(locale);
	},
	{ immediate: true },
);
