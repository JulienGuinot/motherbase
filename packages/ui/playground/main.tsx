import { createRoot } from 'react-dom/client';
import { Gallery } from './gallery.js';
import type { PreviewConnection } from './gallery.js';
import { createLiveClient, readLiveConfiguration } from './config.js';
import '../styles.css';
import './playground.css';

const { config, error } = readLiveConfiguration(import.meta.env);
const client = config ? createLiveClient(config) : null;
const connection: PreviewConnection | undefined = config && client ? {
  mode: 'live',
  client,
  authClient: client,
  providers: config.providers,
  passkeys: config.passkeys,
  url: config.url,
} : undefined;

createRoot(document.getElementById('root')!).render(error
  ? <main className="gallery-config-error" role="alert"><h1>Preview configuration error</h1><p>{error}</p></main>
  : <Gallery connection={connection} />);
