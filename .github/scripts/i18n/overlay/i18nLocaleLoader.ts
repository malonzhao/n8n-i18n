import { shallowRef, watch } from 'vue';
import { locale as designSystemLocale } from '@n8n/design-system';
import { i18n, i18nInstance } from '@n8n/i18n';
import { isRecord } from '@n8n/utils/is-record';

/** Messages of one bundled locale file. */
type LocaleFileMessages = Record<string, unknown>;

/** Lazy import function of one bundled locale file. */
type LocaleLoader = () => Promise<{ default: LocaleFileMessages }>;

/** Locale that the i18n package bundles by default. */
const DEFAULT_LOCALE = 'en';

/** Top-level key of the design system messages in the bundled locale files. */
const DESIGN_SYSTEM_KEY = '_designSystem';

/** Local storage key of the last UI locale, used to preload its messages early. */
const STORAGE_KEY = 'n8n:i18n-overlay-locale';

/** Lazy loaders of the bundled non-English locale files, keyed by locale code. */
const localeLoaders = collectLoaders(
	import.meta.glob<{ default: LocaleFileMessages }>('./i18nLocales/*.json'),
);

/** Loads that are complete or in progress, keyed by locale code. */
const loads = new Map<string, Promise<void>>();

/** Design system messages of the loaded locales, keyed by locale code. */
const designSystemMessages = shallowRef<Record<string, Record<string, unknown>>>({});

/** Maps glob results to locale codes. */
function collectLoaders(modules: Record<string, LocaleLoader>): Map<string, LocaleLoader> {
	const loaders = new Map<string, LocaleLoader>();
	for (const [path, loader] of Object.entries(modules)) {
		const code = /\/([^/]+)\.json$/.exec(path)?.[1];
		if (code && code !== DEFAULT_LOCALE) loaders.set(code, loader);
	}
	return loaders;
}

/** Loads the messages of a locale once, merges them into the i18n instance, and stores its design system messages. */
async function loadLocale(locale: string): Promise<void> {
	const loader = localeLoaders.get(locale);
	if (!loader) return;
	const existing = loads.get(locale);
	if (existing) return await existing;
	const load = loader()
		.then((module) => {
			i18nInstance.global.mergeLocaleMessage(locale, module.default);
			const designSystem = module.default[DESIGN_SYSTEM_KEY];
			if (isRecord(designSystem)) {
				designSystemMessages.value = { ...designSystemMessages.value, [locale]: designSystem };
			}
			i18n.clearCache();
		})
		.catch((error: unknown) => {
			loads.delete(locale);
			console.warn(`Could not load the UI messages for locale "${locale}".`, error);
		});
	loads.set(locale, load);
	return await load;
}

/** Reads the last UI locale from local storage. */
function readStoredLocale(): string | null {
	try {
		return window.localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
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

const storedLocale = readStoredLocale();
if (storedLocale && storedLocale !== DEFAULT_LOCALE) void loadLocale(storedLocale);

watch(
	() => i18nInstance.global.locale.value,
	(locale) => {
		storeLocale(locale);
		if (locale !== DEFAULT_LOCALE) void loadLocale(locale);
	},
	{ immediate: true },
);
