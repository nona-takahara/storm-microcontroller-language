import IntlMessageFormat from "intl-messageformat";

import {
  enMessages,
  jaMessages,
  type MessageArguments,
  type MessageArgsById,
  type MessageId,
  type SupportedLanguage,
} from "./messages.js";

export interface Translator {
  readonly language: SupportedLanguage;
  format<K extends MessageId>(messageId: K, args?: MessageArgsById[K]): string;
}

const catalogs: Record<SupportedLanguage, Readonly<Record<MessageId, string>>> = {
  en: enMessages,
  ja: jaMessages,
};

const formatterCache = new Map<string, IntlMessageFormat>();

export function createTranslator(language: SupportedLanguage): Translator {
  return {
    language,
    format<K extends MessageId>(messageId: K, args?: MessageArgsById[K]) {
      const pattern = catalogs[language][messageId] ?? enMessages[messageId];
      const key = `${language}:${messageId}:${pattern}`;
      let formatter = formatterCache.get(key);

      if (!formatter) {
        formatter = new IntlMessageFormat(pattern, language);
        formatterCache.set(key, formatter);
      }

      return String(formatter.format((args ?? {}) as MessageArguments));
    },
  };
}

export const englishTranslator = createTranslator("en");
