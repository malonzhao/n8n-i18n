import { i18n, i18nInstance, setLanguage } from '@n8n/i18n';
import { isRecord } from '@n8n/utils/is-record';

/** Global state that the boot script of the i18n overlay creates before the editor modules run. */
export interface I18nOverlay {
	base: string;
	nonce: string;
	files: Record<string, string | undefined>;
	locale: string | null;
	messages: Record<string, unknown>;
}

declare global {
	interface Window {
		/** State of the i18n overlay, which is missing when the boot script did not run. */
		__n8nI18nOverlay?: I18nOverlay;
	}
}

/** Merges the messages of the boot locale into the i18n instance and selects that locale. */
function applyBootLocale(): void {
	const overlay = window.__n8nI18nOverlay;
	const locale = overlay?.locale;
	if (!overlay || typeof locale !== 'string') return;
	if (!isRecord(overlay.messages)) return;
	const messages = overlay.messages[locale];
	if (!isRecord(messages)) return;
	i18nInstance.global.mergeLocaleMessage(locale, messages);
	setLanguage(locale);
	i18n.autocompleteUIValues.docLinkLabel = i18n.baseText('expressionEdit.learnMore');
}

try {
	applyBootLocale();
} catch (error) {
	console.warn('Could not apply the UI locale before the editor starts.', error);
}
