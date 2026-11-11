import { useEffect, useState } from 'react';

/**
 * Differences between desktop browsers, iOS Safari and Android Chrome:
 * whether the app is installed to the home screen, how to install it, how to save files.
 */

/** Running as an installed app (opened from the home screen), not a browser tab. */
export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** iPhone / iPad (iPadOS reports itself as a Mac but has a touch screen). */
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Touch is the primary input (phones, tablets). */
export const isTouch = () => window.matchMedia?.('(pointer: coarse)').matches ?? false;

/* ---------- Install (Android / Chrome / Edge fire beforeinstallprompt; iOS does not) ---------- */

interface InstallEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    listeners.forEach((f) => f());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    listeners.forEach((f) => f());
  });
}

/** Install state: installed, installable with a button (Android), or needs a guide (iOS). */
export function useInstall() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
  return {
    installed: isStandalone(),
    canPrompt: !!deferred,
    ios: isIOS(),
    prompt: async () => {
      if (!deferred) return false;
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      deferred = null;
      listeners.forEach((f) => f());
      return outcome === 'accepted';
    },
  };
}

/* ---------- Small per-browser memory (localStorage may be unavailable: private mode…) ---------- */

export const local = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

/* ---------- Saving files: phones open the share sheet, desktops download ---------- */

/** Download a file (desktop). */
export function downloadFile(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * On phones (especially an installed app on iOS) downloading with <a download> is unreliable,
 * so open the system share sheet instead: save to Files / iCloud Drive / Google Drive, send via Zalo, AirDrop…
 * Returns 'shared' | 'downloaded' | 'cancelled' | 'needs-tap'
 * ('needs-tap': the browser wants a fresh tap — because building the file took time — the caller shows a "Chia sẻ file" button).
 */
export async function saveOrShare(blob: Blob, name: string): Promise<'shared' | 'downloaded' | 'cancelled' | 'needs-tap'> {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (isTouch() && nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name });
      return 'shared';
    } catch (e) {
      const n = (e as DOMException).name;
      if (n === 'AbortError') return 'cancelled';
      if (n === 'NotAllowedError') return 'needs-tap';
      // Other errors (e.g. this file type cannot be shared): download like on desktop.
    }
  }
  downloadFile(blob, name);
  return 'downloaded';
}

/* ---------- Storage ---------- */

export interface StorageInfo { persisted: boolean | null; usage: number | null; quota: number | null }

export async function storageInfo(): Promise<StorageInfo> {
  const s = navigator.storage;
  const persisted = s?.persisted ? await s.persisted().catch(() => null) : null;
  const est = s?.estimate ? await s.estimate().catch(() => null) : null;
  return { persisted, usage: est?.usage ?? null, quota: est?.quota ?? null };
}

/** Ask the browser to keep data persistently (less risk of eviction when the device runs low on storage). */
export const requestPersist = () => navigator.storage?.persist?.().catch(() => false) ?? Promise.resolve(false);
