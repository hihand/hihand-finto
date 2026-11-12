import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { db } from '../db/schema';
import { inviteLink, newKey, parseInvite, RelayError, roomOf, runSync, type Progress, type RelayResult, type Role } from '../domain/relay';
import { connectRelay, type RelayConnection } from '../lib/relaySocket';
import { Modal } from './kit';
import { isIOS, isStandalone, isTouch } from './platform';
import { SyncReport } from './SyncReport';

/**
 * Live sync with another device through the relay:
 *  - host: shows a QR code / link (valid 5 minutes) and waits;
 *  - scan: reads the other device's QR code with the camera (in the app — on iPhone the Camera app would open Safari,
 *    whose data is separate from the installed app), or a pasted link;
 *  - join: a sync link was opened in this browser (asks first).
 */
export type LiveMode = { kind: 'host' } | { kind: 'scan' } | { kind: 'paste' } | { kind: 'join'; key: Uint8Array };

/** How long a QR code stays valid (the relay closes the room after the same time). */
const QR_MS = 5 * 60_000;

type Phase =
  | { s: 'scan' }
  | { s: 'paste' }
  | { s: 'confirm'; key: Uint8Array }
  | { s: 'wait'; link: string; until: number }
  | { s: 'connecting' }
  | { s: 'run'; p: Progress }
  | { s: 'done'; r: RelayResult }
  | { s: 'error'; msg: string; retry?: LiveMode };

const canScan = () => !!navigator.mediaDevices?.getUserMedia;

type WakeLock = { release: () => Promise<void> };
const keepAwake = async (): Promise<WakeLock | null> =>
  (await (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLock> } }).wakeLock?.request('screen').catch(() => null)) ?? null;

export default function LiveSync({ mode, onClose }: { mode: LiveMode; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>(() =>
    mode.kind === 'scan' ? { s: 'scan' } : mode.kind === 'paste' ? { s: 'paste' } : mode.kind === 'join' ? { s: 'confirm', key: mode.key } : { s: 'connecting' });
  // Each attempt gets a number; stop() bumps it so a superseded attempt (retry, unmount) closes itself and stays quiet.
  const gen = useRef(0);
  const conn = useRef<RelayConnection | null>(null);
  const wake = useRef<WakeLock | null>(null);

  const stop = useCallback(() => {
    gen.current++;
    conn.current?.close();
    conn.current = null;
    void wake.current?.release().catch(() => {});
    wake.current = null;
  }, []);

  /** Connect to the room for `key` and run the session. */
  const go = useCallback(async (key: Uint8Array, role: Role, retry: LiveMode) => {
    stop();
    const me = gen.current;
    const set = (p: Phase) => { if (gen.current === me) setPhase(p); };
    let c: RelayConnection | null = null;
    try {
      set({ s: 'connecting' });
      // Keep the phone screen on while waiting / syncing (a sleeping phone drops the connection).
      const lock = await keepAwake();
      const room = await roomOf(key);
      if (gen.current !== me) { void lock?.release().catch(() => {}); return; }
      wake.current = lock;
      c = connectRelay(room, role);
      conn.current = c;
      if (role === 'host') set({ s: 'wait', link: inviteLink(location.origin, key), until: Date.now() + QR_MS });
      await c.paired;
      set({ s: 'run', p: { step: 'hello' } });
      const r = await runSync(db, c, key, role, { onProgress: (p) => set({ s: 'run', p }) });
      set({ s: 'done', r });
    } catch (e) {
      if ((e as RelayError).code !== 'cancelled') set({ s: 'error', msg: (e as Error).message, retry });
    } finally {
      c?.close();
      if (gen.current === me) stop();
    }
  }, [stop]);

  const host = useCallback(() => go(newKey(), 'host', { kind: 'host' }), [go]);
  const join = useCallback((key: Uint8Array) => go(key, 'guest', { kind: 'scan' }), [go]);

  // Host: create the QR code right away. Cleanup closes the connection (and, in dev StrictMode, the remount starts a fresh one).
  const kind = mode.kind;
  useEffect(() => {
    if (kind === 'host') void host();
    return stop;
  }, [kind, host, stop]);

  // QR countdown: give up when it runs out (the relay does the same).
  useEffect(() => {
    if (phase.s !== 'wait') return;
    const t = setTimeout(() => {
      stop();
      setPhase({ s: 'error', msg: 'Mã QR đã hết hạn mà chưa có máy nào quét.', retry: { kind: 'host' } });
    }, Math.max(0, phase.until - Date.now()));
    return () => clearTimeout(t);
  }, [phase, stop]);

  const close = () => { stop(); onClose(); };
  const busy = phase.s === 'run' || phase.s === 'connecting';
  const title = phase.s === 'scan' ? 'Quét mã QR' : phase.s === 'paste' || phase.s === 'confirm' ? 'Đồng bộ với máy khác' : 'Đồng bộ trực tiếp';

  return (
    <Modal title={title} onClose={() => { if (!busy || confirm('Dừng đồng bộ? Phần chưa nhận đủ sẽ không được gộp.')) close(); }}>
      {phase.s === 'wait' && <Waiting link={phase.link} until={phase.until} />}
      {phase.s === 'scan' && <Scanner onKey={join} onPaste={() => setPhase({ s: 'paste' })} />}
      {phase.s === 'paste' && <PasteLink onKey={join} />}
      {phase.s === 'confirm' && <ConfirmJoin onYes={() => join(phase.key)} onNo={close} />}
      {phase.s === 'connecting' && <p className="muted" aria-live="polite">Đang kết nối…</p>}
      {phase.s === 'run' && <Running p={phase.p} />}
      {phase.s === 'done' && (
        <>
          <SyncReport report={phase.r.report} title={`Đã đồng bộ với ${phase.r.peer.name}`}
            extra={phase.r.sent ? `Gửi ${phase.r.sent} bản ghi${phase.r.full ? ' (lần đầu: gửi đầy đủ)' : ''}.` : 'Gửi: máy kia đã có đủ.'} />
          <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn primary" onClick={close}>Xong</button></div>
        </>
      )}
      {phase.s === 'error' && (
        <>
          <div className="summary warn"><span className="small">{phase.msg}</span></div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={close}>Đóng</button>
            {phase.retry && (
              <button type="button" className="btn primary" onClick={() => {
                const r = phase.retry!;
                if (r.kind === 'host') void host();
                else setPhase(canScan() ? { s: 'scan' } : { s: 'paste' });
              }}>{phase.retry.kind === 'host' ? 'Tạo mã mới' : 'Quét lại'}</button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

/* ---------- Host: QR code + link + countdown ---------- */

function Waiting({ link, until }: { link: string; until: number }) {
  const [svg, setSvg] = useState<{ size: number; path: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let ok = true;
    void import('uqr').then(({ encode }) => {
      const qr = encode(link, { ecc: 'M', border: 2 });
      let path = '';
      qr.data.forEach((row, y) => row.forEach((on, x) => { if (on) path += `M${x} ${y}h1v1h-1z`; }));
      if (ok) setSvg({ size: qr.size, path });
    });
    return () => { ok = false; };
  }, [link]);
  const [nowMs, setNowMs] = useState(until - QR_MS);
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((until - nowMs) / 1000));
  return (
    <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
      <span className="small">Trên máy kia: mở Finto › Cài đặt › Đồng bộ › <b>Quét mã QR</b>.</span>
      <div className="qr-box" aria-label="Mã QR đồng bộ">
        {svg ? (
          <svg viewBox={`0 0 ${svg.size} ${svg.size}`} shapeRendering="crispEdges" role="img" aria-label="Mã QR">
            <rect width={svg.size} height={svg.size} fill="#fff" />
            <path d={svg.path} fill="#000" />
          </svg>
        ) : <span className="muted small">Đang tạo mã…</span>}
      </div>
      <span className="small strong" aria-live="off">Còn hiệu lực {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>
      <span className="small muted" aria-live="polite">Đang chờ máy kia quét… Giữ màn hình này mở.</span>
      <details className="small" style={{ alignSelf: 'stretch', textAlign: 'left' }}>
        <summary>Máy kia không có camera (máy tính)?</summary>
        <div className="stack tight" style={{ marginTop: 8 }}>
          <span className="muted">Gửi link này sang máy kia (Zalo, email…) rồi mở bằng trình duyệt đang dùng Finto ở đó, hoặc dán vào ô “Dán link”. Link chỉ dùng được một lần, trong 5 phút.</span>
          <input className="input" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Link đồng bộ" />
          <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={async () => {
            try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* the field can be copied by hand */ }
          }}>{copied ? 'Đã sao chép' : 'Sao chép link'}</button>
        </div>
      </details>
    </div>
  );
}

/* ---------- Guest: camera scanner / pasted link ---------- */

type Detect = (v: HTMLVideoElement) => Promise<string | null>;

/** Native BarcodeDetector where available (Android Chrome); otherwise jsQR (iOS Safari, Firefox), loaded on demand. */
async function makeDetector(): Promise<Detect> {
  const BD = (window as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): { detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]> }; getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector;
  const formats: string[] = (await BD?.getSupportedFormats?.().catch(() => [])) ?? [];
  if (BD && formats.includes('qr_code')) {
    const d = new BD({ formats: ['qr_code'] });
    return async (v) => (await d.detect(v))[0]?.rawValue ?? null;
  }
  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return async (v) => {
    if (!v.videoWidth) return null;
    const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
  };
}

const cameraError = (e: unknown) => {
  const n = (e as DOMException)?.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    return isIOS()
      ? 'Chưa cho phép dùng camera. Vào Cài đặt của iPhone › Safari (hoặc Finto) › Camera › Cho phép, rồi thử lại — hoặc dán link.'
      : 'Chưa cho phép dùng camera. Bật quyền camera cho trang này rồi thử lại — hoặc dán link.';
  }
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Không tìm thấy camera trên máy này. Hãy dán link thay vì quét.';
  return 'Không mở được camera. Hãy dán link thay vì quét.';
};

function Scanner({ onKey, onPaste }: { onKey: (k: Uint8Array) => void; onPaste: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer = 0;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (stopped) return;
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const detect = await makeDetector();
        const loop = async () => {
          if (stopped) return;
          const text = await detect(v).catch(() => null);
          if (stopped) return;
          if (text) {
            const key = parseInvite(text);
            if (key) { stopped = true; stream?.getTracks().forEach((t) => t.stop()); onKey(key); return; }
            setHint('Mã này không phải mã đồng bộ của Finto.');
          }
          timer = window.setTimeout(loop, 200);
        };
        void loop();
      } catch (e) {
        if (!stopped) setErr(cameraError(e));
      }
    })();
    return () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [onKey]);
  return (
    <div className="stack">
      {err ? <div className="summary warn"><span className="small">{err}</span></div> : (
        <>
          <video ref={video} className="scan-video" playsInline muted autoPlay aria-label="Camera" />
          <span className="small muted" aria-live="polite">{hint ?? 'Hướng camera vào mã QR trên máy kia (Cài đặt › Đồng bộ › Hiện mã QR).'}</span>
        </>
      )}
      <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={onPaste}>Dán link thay vì quét</button>
    </div>
  );
}

function PasteLink({ onKey }: { onKey: (k: Uint8Array) => void }) {
  const [text, setText] = useState('');
  const key = useMemo(() => parseInvite(text), [text]);
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (key) onKey(key); }}>
      <label className="small" htmlFor="sync-link">Dán link đồng bộ từ máy kia (Cài đặt › Đồng bộ › Hiện mã QR › “Máy kia không có camera?”).</label>
      <input id="sync-link" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="https://finto.hihandlabs.online/#sync=…" autoComplete="off" />
      {text && !key && <span className="small c-give">Link chưa đúng — cần có phần “#sync=…”.</span>}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button type="submit" className="btn primary" disabled={!key}>Kết nối</button></div>
    </form>
  );
}

function ConfirmJoin({ onYes, onNo }: { onYes: () => void; onNo: () => void }) {
  const safariTab = isIOS() && isTouch() && !isStandalone();
  return (
    <div className="stack">
      <span>Bạn vừa mở một link đồng bộ. Kết nối với máy đã tạo link và đồng bộ dữ liệu hai bên?</span>
      {safariTab && (
        <div className="summary warn"><span className="small">
          Bạn đang ở <b>tab Safari</b>, không phải app Finto đã cài — dữ liệu ở đây <b>tách riêng</b> với app.
          Nếu bạn dùng app Finto trên màn hình chính, hãy mở app rồi dùng <b>Quét mã QR</b> trong Cài đặt › Đồng bộ.
        </span></div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onNo}>Hủy</button>
        <button type="button" className="btn primary" onClick={onYes}>{safariTab ? 'Vẫn đồng bộ ở đây' : 'Đồng bộ'}</button>
      </div>
    </div>
  );
}

/* ---------- Progress ---------- */

function Running({ p }: { p: Progress }) {
  const label = p.step === 'hello' ? 'Đã kết nối, đang chuẩn bị dữ liệu…'
    : p.step === 'sending' ? `Đang gửi dữ liệu… ${p.done}/${p.total}`
    : p.step === 'receiving' ? `Đang nhận dữ liệu… ${p.done}/${p.total}`
    : p.step === 'merging' ? 'Đang gộp dữ liệu… (lần đầu với sổ nhiều năm có thể mất khoảng nửa phút)' : 'Xong';
  const pct = p.total ? Math.round(((p.done ?? 0) / p.total) * 100) : p.step === 'merging' ? 100 : 0;
  return (
    <div className="stack" aria-live="polite">
      <span>Đang đồng bộ với <b>{p.peer?.name ?? 'máy kia'}</b></span>
      <span className="small muted">{label}</span>
      <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: `${pct}%` }} /></div>
      <span className="xs muted">Giữ cả hai máy mở màn hình này cho đến khi xong.</span>
    </div>
  );
}
