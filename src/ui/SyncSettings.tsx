import { lazy, Suspense, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema';
import {
  buildPackage, forgetPeer, getDevice, getPeers, importPackage, packageFileName, packageSize, packageToText, pendingFor, readPackage, setDeviceName,
  type ImportReport, type SyncPackage,
} from '../domain/sync';
import { useSaveFile } from './download';
import { useRun } from './format';
import { clearInvite, peekInvite } from './invite';
import { Empty } from './kit';
import type { LiveMode } from './LiveSync';
import { isIOS } from './platform';
import { SyncReport } from './SyncReport';

// The live-sync dialog (QR code, camera, relay) is only loaded when used.
const LiveSync = lazy(() => import('./LiveSync'));
const canScan = () => !!navigator.mediaDevices?.getUserMedia;

const when = (iso?: string) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * Sync between browsers / devices:
 *  - live, with a QR code or link: both devices online, data goes end-to-end encrypted through the relay (nothing stored there);
 *  - advanced: JSON packages sent by hand (USB, Zalo, email, Drive…), works offline.
 * Both merge (not overwrite) and keep a "what has been synced" table per device, so only new changes are sent.
 */
export default function SyncSettings() {
  const run = useRun();
  const saveFile = useSaveFile();
  const [live, setLive] = useState<LiveMode | null>(() => {
    const key = peekInvite();
    return key ? { kind: 'join', key } : null;
  });
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState<{ text: string; fromName: string } | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [nameText, setNameText] = useState<string | null>(null);

  const state = useLiveQuery(async () => {
    // Read only (liveQuery cannot write); the device id was created on app start.
    const device = ((await db.meta.get('device'))?.value as Awaited<ReturnType<typeof getDevice>> | undefined) ?? { id: '—', name: 'Trình duyệt này' };
    const peers = Object.values(await getPeers(db));
    const rows = await Promise.all(peers.map(async (p) => ({ ...p, pending: await pendingFor(db, p.id) })));
    const at = (p: (typeof rows)[number]) => [p.lastIn?.at ?? '', p.lastOut?.at ?? ''].sort().pop()!;
    return { device, peers: rows.sort((a, b) => at(b).localeCompare(at(a))) };
  });
  if (!state) return <p className="muted">Đang tải…</p>;
  const { device, peers } = state;

  const exportFor = async (to: string | null, toName?: string) => {
    const pkg = await run(() => buildPackage(db, to));
    if (!pkg) return;
    const p = pkg as SyncPackage;
    const text = await packageToText(p, password || undefined);
    await saveFile(new Blob([text], { type: 'application/json' }), packageFileName(p, toName),
      `Đã tạo gói ${packageSize(p)} bản ghi${to ? ` cho ${toName}` : ' (đầy đủ)'}${password ? ' · đã mã hóa' : ''}`);
  };

  const doImport = async (text: string, pw?: string) => {
    const r = await run(() => readPackage(text, pw));
    if (!r) return;
    if ('needPassword' in r) {
      setPending({ text, fromName: r.fromName });
      return;
    }
    setPending(null);
    const rep = await run(() => importPackage(db, r.pkg));
    if (rep) setReport(rep as ImportReport);
  };

  return (
    <div className="stack" style={{ maxWidth: 960 }}>
      <section className="card stack">
        <h2>Đồng bộ bằng mã QR</h2>
        <span className="small muted">
          Mở Finto trên cả hai máy (có mạng). Một máy <b>hiện mã QR</b>, máy kia <b>quét</b> — hai bên gửi cho nhau những gì còn thiếu rồi <b>gộp</b> lại
          (không ghi đè: sửa ở cả hai máy cũng không mất gì, bản sửa sau thắng). Dữ liệu được mã hóa bằng khóa chỉ có trong mã QR;
          máy chủ trung gian chỉ chuyển tiếp, không đọc được và không lưu lại.
        </span>
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" className="btn primary" onClick={() => setLive({ kind: 'host' })}>Hiện mã QR</button>
          {canScan() && <button type="button" className="btn primary" onClick={() => setLive({ kind: 'scan' })}>Quét mã QR</button>}
          <button type="button" className="btn" onClick={() => setLive({ kind: 'paste' })}>Dán link</button>
        </div>
        <span className="xs muted">
          Nhiều máy: đồng bộ lần lượt qua một máy (ví dụ điện thoại quét máy 1, rồi máy 2, rồi máy 1 lần nữa) là tất cả giống nhau.
          {isIOS() && ' Trên iPhone: quét bằng nút “Quét mã QR” trong app, đừng dùng app Camera (link sẽ mở trong Safari — dữ liệu ở đó tách riêng với app).'}
        </span>
        <div className="setting">
          <div className="grow stack tight">
            <label className="strong" htmlFor="sync-name">Tên máy này</label>
            <span className="xs muted">Hiện ở máy kia khi đồng bộ · mã máy {device.id.slice(0, 8)}</span>
          </div>
          <input id="sync-name" className="input" style={{ width: 240 }} value={nameText ?? device.name} onChange={(e) => setNameText(e.target.value)}
            onBlur={() => { if (nameText !== null && nameText.trim() !== device.name) run(() => setDeviceName(db, nameText), 'Đã đổi tên máy'); setNameText(null); }} />
        </div>
      </section>

      <section className="card stack">
        <h2>Đã đồng bộ với</h2>
        {peers.length === 0 ? <Empty>Chưa đồng bộ với máy nào.</Empty> : (
          <div className="list">
            {peers.map((p) => (
              <div className="item" key={p.id} style={{ flexWrap: 'wrap', alignItems: 'flex-start', gap: 12 }}>
                <span className="grow stack tight" style={{ minWidth: 220 }}>
                  <span className="title">{p.name}</span>
                  <span className="meta">
                    Nhận lần cuối: {when(p.lastIn?.at)}{p.lastIn ? ` (+${p.lastIn.added} mới, ${p.lastIn.updated} cập nhật)` : ''}
                  </span>
                  <span className="meta">
                    Gửi lần cuối: {when(p.lastOut?.at)}{p.lastOut ? ` (${p.lastOut.count} bản ghi${p.lastOut.full ? ', đầy đủ' : ''})` : ''}
                    {p.ackedByThem ? ' · máy đó đã xác nhận' : ' · máy đó chưa xác nhận lần gửi nào'}
                  </span>
                </span>
                <span className={`small strong ${p.pending ? 'c-owe' : 'c-income'}`} style={{ alignSelf: 'center' }}>
                  {p.pending ? `${p.pending} thay đổi chưa gửi` : 'Đã đồng bộ hết'}
                </span>
                <span className="row" style={{ gap: 6, alignSelf: 'center' }}>
                  <button type="button" className="btn sm" onClick={() => {
                    if (confirm(`Quên “${p.name}”? Lần sau đồng bộ với máy đó sẽ gửi đầy đủ. Dữ liệu không bị xóa.`)) run(() => forgetPeer(db, p.id), 'Đã quên máy');
                  }}>Quên</button>
                </span>
              </div>
            ))}
          </div>
        )}
        <span className="xs muted">
          “Chưa gửi” chỉ tính các thay đổi máy kia chưa có — những gì vừa nhận từ chính máy đó không gửi ngược lại.
          Đồng bộ bị ngắt giữa chừng cũng không sao: máy kia chưa xác nhận thì lần sau vẫn gửi lại.
        </span>
      </section>

      <details className="card stack">
        <summary className="strong">Nâng cao: đồng bộ bằng file (không cần mạng)</summary>
        <span className="small muted">
          Trình duyệt này tạo <b>gói đồng bộ</b> (file JSON), bạn gửi file sang máy kia (USB, Zalo, email, Drive…) rồi bấm “Nhập gói” ở đó.
          Cũng là gộp như đồng bộ bằng mã QR, và dùng chung bảng “Đã đồng bộ với”.
        </span>
        <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
          <li>Máy mới: ở máy đang có dữ liệu bấm <b>Xuất gói đầy đủ</b> → nhập ở máy mới.</li>
          <li>Ở máy mới bấm <b>Xuất gói</b> cho máy kia → nhập lại ở máy kia (để hai bên xác nhận đã có của nhau).</li>
          <li>Những lần sau: máy nào vừa nhập liệu thì xuất gói cho máy kia.</li>
        </ol>
        <div className="setting">
          <div className="grow stack tight">
            <label className="strong" htmlFor="sync-pw">Mật khẩu gói (không bắt buộc)</label>
            <span className="xs muted">Có mật khẩu thì gói được mã hóa (AES-GCM) — nên dùng khi gửi qua Zalo / email / Drive. Không lưu lại; nhập giống nhau ở các máy.</span>
          </div>
          <input id="sync-pw" type="password" className="input" style={{ width: 240 }} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="row wrap" style={{ justifyContent: 'flex-end', gap: 8 }}>
          {peers.map((p) => (
            <button type="button" className="btn sm" key={p.id} onClick={() => exportFor(p.id, p.name)}>Xuất gói cho {p.name}</button>
          ))}
          <button type="button" className="btn sm" onClick={() => exportFor(null)}>Xuất gói đầy đủ (máy mới)</button>
          <label className="btn sm primary">
            Nhập gói đồng bộ
            <input type="file" accept="application/json,.json" hidden onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) await doImport(await f.text(), password || undefined);
            }} />
          </label>
        </div>
        {pending && (
          <div className="summary warn stack tight">
            <span className="small">Gói từ <b>{pending.fromName || 'máy khác'}</b> đã được mã hóa. Nhập mật khẩu gói ở trên rồi bấm:</span>
            <div className="row"><button type="button" className="btn sm primary" disabled={!password} onClick={() => doImport(pending.text, password)}>Mở gói</button>
              <button type="button" className="btn sm" onClick={() => setPending(null)}>Hủy</button></div>
          </div>
        )}
        {report && <SyncReport report={report} onClose={() => setReport(null)} />}
      </details>

      {live && (
        <Suspense fallback={null}>
          <LiveSync mode={live} onClose={() => { clearInvite(); setLive(null); }} />
        </Suspense>
      )}
    </div>
  );
}
