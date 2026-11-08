import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Settings } from './db/schema';

/** Áp theme lên <html data-theme>; "system" theo cài đặt sáng/tối của máy. */
export function useTheme() {
  const settings = useLiveQuery(() => db.settings.get('settings'));
  const pref = settings?.theme ?? 'dark';

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const mode = pref === 'system' ? (mq.matches ? 'light' : 'dark') : pref;
      document.documentElement.dataset.theme = mode;
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [pref]);

  const setTheme = (theme: Settings['theme']) => db.settings.update('settings', { theme });
  return { pref, setTheme };
}
