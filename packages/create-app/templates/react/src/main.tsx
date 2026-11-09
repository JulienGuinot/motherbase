import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { MotherbaseProvider } from '@motherbase/ui';
import '@motherbase/ui/styles.css';
import './styles/app.css';
import { App } from './app';
import { motherbase } from './lib/motherbase';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {motherbase ? (
      <MotherbaseProvider client={motherbase}>
        <BrowserRouter><App /></BrowserRouter>
      </MotherbaseProvider>
    ) : (
      <main className="setup">
        <p className="eyebrow">Setup required</p>
        <h1>Connect your Motherbase project.</h1>
        <p>Copy <code>.env.example</code> to <code>.env.local</code>, then set the URL and public key.</p>
      </main>
    )}
  </StrictMode>,
);
