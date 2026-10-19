import '@fontsource/archivo/400.css';
import '@fontsource/archivo/600.css';
import '@fontsource/archivo/700.css';
import '@fontsource/archivo-narrow/500.css';
import '@fontsource/archivo-narrow/600.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CustomerDisplay } from './components/CustomerDisplay';
import { I18nProvider } from './i18n';
import { TillProvider } from './lib/till';
import './styles.css';

// The customer display (session 16) is the same app opened with ?display=customer: no till, no sign-in.
const display = new URLSearchParams(location.search).get('display') === 'customer';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      {display ? (
        <CustomerDisplay />
      ) : (
        <TillProvider>
          <App />
        </TillProvider>
      )}
    </I18nProvider>
  </StrictMode>,
);
