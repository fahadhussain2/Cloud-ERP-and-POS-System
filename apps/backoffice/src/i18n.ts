import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';

// UI text comes only from translation keys (CLAUDE.md rule 10).
export const i18n = i18next.createInstance();

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  initAsync: false,
  interpolation: { escapeValue: false },
});
