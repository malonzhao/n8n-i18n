/** Boot script of the i18n overlay that loads the messages of the UI locale before the editor modules run. */
(function () {
	/** Locale that the editor bundles by default. */
	var DEFAULT_LOCALE = 'en';

	/** Local storage key of the last UI locale. */
	var STORAGE_KEY = 'n8n:i18n-overlay-locale';

	/** Locale file names with a content hash, keyed by locale code. */
	var FILES = /*__I18N_OVERLAY_FILES__*/ {};

	/** Returns the value with the characters escaped that are special in an HTML attribute. */
	function escapeAttribute(value) {
		return String(value)
			.replace(/&/g, '&amp;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}

	/** Returns the default locale of the settings that the server embeds in the page, or null. */
	function readEmbeddedLocale() {
		var settings = window.__n8nSettings;
		if (!settings || typeof settings !== 'object') return null;
		var locale = settings.defaultLocale;
		return typeof locale === 'string' && locale !== '' ? locale : null;
	}

	/** Returns the last UI locale from local storage, or null. */
	function readStoredLocale() {
		try {
			var locale = window.localStorage.getItem(STORAGE_KEY);
			return typeof locale === 'string' && locale !== '' ? locale : null;
		} catch (error) {
			return null;
		}
	}

	try {
		var script = document.currentScript;
		var src = script && typeof script.src === 'string' ? script.src : '';
		var nonce = script && typeof script.nonce === 'string' ? script.nonce : '';
		var base = src.slice(0, src.lastIndexOf('/') + 1);
		var overlay = { base: base, nonce: nonce, files: FILES, locale: null, messages: {} };
		window.__n8nI18nOverlay = overlay;

		var locale = readEmbeddedLocale() || readStoredLocale();
		if (!locale || locale === DEFAULT_LOCALE || base === '') return;
		if (!Object.prototype.hasOwnProperty.call(FILES, locale)) return;
		if (typeof FILES[locale] !== 'string') return;

		overlay.locale = locale;
		document.write(
			'<script src="' +
				escapeAttribute(base + FILES[locale]) +
				'"' +
				(nonce ? ' nonce="' + escapeAttribute(nonce) + '"' : '') +
				'></script>',
		);
	} catch (error) {
		console.warn('Could not load the UI messages before the editor starts.', error);
	}
})();
