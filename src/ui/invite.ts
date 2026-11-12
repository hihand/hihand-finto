import { parseInvite } from '../domain/relay';

/**
 * A sync link was opened (…/#sync=KEY, e.g. on a second computer). Called once at startup:
 * keep the key in memory only, remove it from the address bar and history, and open Settings › Đồng bộ,
 * which asks before connecting.
 */
let pending: Uint8Array | null = null;

export function captureInvite() {
  const key = parseInvite(location.hash);
  if (!key) return;
  pending = key;
  history.replaceState(null, '', '/cai-dat?tab=dong-bo');
}

export const peekInvite = () => pending;
export const clearInvite = () => { pending = null; };
