import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/nunito/latin-400.css';
import '@fontsource/nunito/latin-600.css';
import '@fontsource/nunito/latin-700.css';
import '@fontsource/nunito/latin-800.css';
import '@fontsource/nunito/vietnamese-400.css';
import '@fontsource/nunito/vietnamese-600.css';
import '@fontsource/nunito/vietnamese-700.css';
import '@fontsource/nunito/vietnamese-800.css';
import './index.css';
import App from './App';
import { db } from './db/schema';
import { seedIfEmpty } from './db/seed';
import { getDevice } from './domain/sync';
import { runMonthEnd } from './domain/monthEnd';
import { today } from './domain/period';

// Ask the browser to keep data persistently (less risk of eviction), then create the default data on first run.
navigator.storage?.persist?.();

// The on-screen keyboard covers part of the screen on phones: track the visible area so dialogs are not hidden (CSS --vvh / --vvt).
const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
    document.documentElement.style.setProperty('--vvt', `${vv.offsetTop}px`);
  };
  fit();
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
}
await seedIfEmpty(db);
// This browser's own id, used when syncing with other browsers.
await getDevice(db);
// Month-end surplus notes run on the first app open in a new period (there is no background server).
await runMonthEnd(db, today()).catch(() => 0);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
