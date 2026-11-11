import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Person, ShareType } from '../db/schema';
import { money, type Toast, ToastCtx, usePrivacy } from './format';

const PATHS: Record<string, string> = {
  utensils: 'M7 3v8a2 2 0 0 0 2 2v8M11 3v8a2 2 0 0 1-2 2M17 3c-2 2-2 7 0 9v9',
  bike: 'M5.5 17.5a3.5 3.5 0 1 0 0-.01M18.5 17.5a3.5 3.5 0 1 0 0-.01M5.5 17.5L9 9h5l4.5 8.5M14 9l-2-4h-2',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  bag: 'M5 8h14l-1 13H6zM9 8V6a3 3 0 0 1 6 0v2',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4',
  gift: 'M4 11h16v10H4zM3 7h18v4H3zM12 7v14M12 7c-2-4-6-3-5 0M12 7c2-4 6-3 5 0',
  send: 'M21 3L10 14M21 3l-7 18-4-7-7-4z',
  dots: 'M6 12h.01M12 12h.01M18 12h.01',
  home: 'M3 11l9-7 9 7v9H3z',
  list: 'M4 6h16M4 12h16M4 18h10',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  users: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 5a3 3 0 0 1 0 6M18 14.5c2 .6 3.2 2.5 3.5 5.5',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5',
  chevron: 'M6 9l6 6 6-6',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6L6 18',
  wallet: 'M3 7h18v13H3zM3 7l3-4h12l3 4M16 14h2',
  income: 'M12 19V5M5 12l7 7 7-7',
  outgo: 'M12 5v14M5 12l7-7 7 7',
  // iOS Share button: an arrow coming out of a box.
  share: 'M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
};

export function Icon({ name, size = 20, stroke = 2 }: { name: string; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.dots} />
    </svg>
  );
}

export function Avatar({ person, size = 40 }: { person?: Pick<Person, 'name' | 'color'> | null; size?: number }) {
  const name = person?.name ?? 'Tôi';
  const initial = person ? name.trim().charAt(0).toUpperCase() : 'Tôi';
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: person ? size * 0.4 : size * 0.32, ['--av' as string]: person?.color ?? 'var(--primary)' }} aria-hidden="true">
      {initial}
    </span>
  );
}

export function Pill({ kind, children }: { kind: ShareType | 'in' | 'paid' | 'partial' | 'open'; children: ReactNode }) {
  return <span className={`pill pill-${kind}`}>{children}</span>;
}

/** 3-color bar: myself / given / advanced. */
export function SplitBar({ mine, give, owe }: { mine: number; give: number; owe: number }) {
  const total = mine + give + owe || 1;
  return (
    <div className="splitbar" role="img" aria-label={`Bản thân ${money(mine)}, cho đi ${money(give)}, ứng trước ${money(owe)}`}>
      <span style={{ width: `${(mine / total) * 100}%`, background: 'var(--primary)' }} />
      <span style={{ width: `${(give / total) * 100}%`, background: 'var(--give)' }} />
      <span style={{ width: `${(owe / total) * 100}%`, background: 'var(--owe)' }} />
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: [T, string][]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button type="button" key={v} aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

/** Brand mark: the low-poly deer (see brand/ and the Hihand Finto Brand guide). */
export function BrandMark({ size = 36 }: { size?: number }) {
  // The Hihand Finto deer mark on its midnight tile (same artwork as the app icon).
  return <img className="brand-mark" src="/brand-mark.png" width={size} height={size} alt="" aria-hidden="true" />;
}

/** Eye button: hide / show income, balances, left over. */
export function PrivacyToggle() {
  const { hidden, toggle } = usePrivacy();
  return (
    <button type="button" className="icon-btn" aria-pressed={hidden} onClick={toggle}
      aria-label={hidden ? 'Hiện thu nhập và số dư' : 'Ẩn thu nhập và số dư'} title={hidden ? 'Hiện thu nhập và số dư' : 'Ẩn thu nhập và số dư'}>
      <Icon name={hidden ? 'eyeOff' : 'eye'} />
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, select, button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="row between">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Đóng" onClick={onClose}><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------- Toasts + undo ---------- */

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<(Toast & { id: number }) | null>(null);
  const timer = useRef<number>(0);
  const show = useCallback((t: Toast, ms = 4000) => {
    window.clearTimeout(timer.current);
    setMsg({ ...t, id: Date.now() });
    timer.current = window.setTimeout(() => setMsg(null), ms);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="toast-wrap" aria-live="polite">
        {msg && (
          <div className={`toast${msg.error ? ' error' : ''}`} key={msg.id}>
            <span>{msg.text}</span>
            {msg.action && (
              <button type="button" onClick={() => { msg.action!.run(); setMsg(null); }}>{msg.action.label}</button>
            )}
          </div>
        )}
      </div>
    </ToastCtx.Provider>
  );
}

/**
 * Phone number keypads have no "k" / "tr": quick buttons under the amount field.
 * Pressing them keeps focus on the field (keyboard stays, no reformatting halfway). Only shown on touch screens.
 */
export function AmountKeys({ onAdd }: { onAdd: (suffix: string) => void }) {
  return (
    <div className="amount-keys" role="group" aria-label="Gõ nhanh số tiền">
      {['000', 'k', 'tr'].map((k) => (
        <button type="button" key={k} className="chip sm" onPointerDown={(e) => e.preventDefault()} onClick={() => onAdd(k)}>{k}</button>
      ))}
    </div>
  );
}
