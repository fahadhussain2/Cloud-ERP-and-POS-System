import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { App } from './App';
import { i18n } from './i18n';
import en from './locales/en.json';

describe('App', () => {
  it('renders its text from translation keys', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>,
    );

    expect(screen.getByRole('heading').textContent).toBe(en.app.title);
    expect(screen.getByText(en.app.placeholder)).toBeDefined();
  });
});
