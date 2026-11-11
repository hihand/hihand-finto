import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Settings } from './db/schema';

/** Apply the theme to <html data-theme>; "system" follows the device light / dark setting. */
export function useTheme() {
  const settings = useLiveQuery(() => db.settings.get('settings'));
  const pref = settings?.theme ?? 'dark';

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const mode = pref === 'system' ? (mq.matches ? 'light' : 'dark') : pref;
      document.documentElement.dataset.theme = mode;
      // Status bar (Android) / address bar color follows the theme.
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', mode === 'light' ? '#ffffff' : '#1a1726');
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [pref]);

  const setTheme = (theme: Settings['theme']) => db.settings.update('settings', { theme });
  return { pref, setTheme };
}
