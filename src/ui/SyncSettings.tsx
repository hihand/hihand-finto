import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema';
import {
  buildPackage, forgetPeer, getDevice, getPeers, importPackage, packageFileName, packageSize, packageToText, pendingFor, readPackage, setDeviceName,
  type ImportReport, type SyncPackage,
} from '../domain/sync';
import { saveBlob } from './download';
import { useRun, useToast } from './format';
import { Empty } from './kit';

const when = (iso?: string) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const TABLE_NAME: Record<string, string> = {
  transactions: 'giao dịch', shares: 'phần chia', incomes: 'thu nhập', settlements: 'lần nhận / trả lại', allocations: 'khoản trừ',
  people: 'người', categories: 'danh mục', tags: 'tag', payables: 'khoản nợ', repayments: 'lần trả nợ',
  categoryTags: 'tag của danh mục', transactionTags: 'tag của giao dịch', groups: 'nhóm', groupMembers: 'thành viên nhóm', monthNotes: 'ghi chú cuối tháng',
};

/**
 * Đồng bộ giữa các trình duyệt bằng gói JSON (gửi qua USB, Zalo, email, Drive…):
 * tên máy này, bảng "đã đồng bộ những gì" với từng máy, xuất gói (chỉ phần mới) và nhập gói (gộp, không ghi đè).
 */
export default function SyncSettings() {
  const run = useRun();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState<{ text: string; fromName: string } | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [nameText, setNameText] = useState<string | null>(null);

  const state = useLiveQuery(async () => {
    // Chỉ đọc (liveQuery không được ghi); mã máy đã được tạo lúc mở app.
    const device = ((await db.meta.get('device'))?.value as Awaited<ReturnType<typeof getDevice>> | undefined) ?? { id: '—', name: 'Trình duyệt này' };
    const peers = Object.values(await getPeers(db));
    const rows = await Promise.all(peers.map(async (p) => ({ ...p, pending: await pendingFor(db, p.id) })));
    return { device, peers: rows.sort((a, b) => (b.lastIn?.at ?? '').localeCompare(a.lastIn?.at ?? '')) };
  });
  if (!state) return <p className="muted">Đang tải…</p>;
  const { device, peers } = state;

  const exportFor = async (to: string | null, toName?: string) => {
    const pkg = await run(() => buildPackage(db, to));
    if (!pkg) return;
    const p = pkg as SyncPackage;
    const text = await packageToText(p, password || undefined);
    saveBlob(new Blob([text], { type: 'application/json' }), packageFileName(p, toName));
    toast({ text: `Đã tạo gói ${packageSize(p)} bản ghi${to ? ` cho ${toName}` : ' (đầy đủ)'}${password ? ' · đã mã hóa' : ''}` });
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
        <h2>Đồng bộ giữa các trình duyệt</h2>
        <span className="small muted">
          Không cần máy chủ: trình duyệt này tạo <b>gói đồng bộ</b> (file JSON), bạn gửi file sang máy kia (USB, Zalo, email, Drive…) rồi bấm “Nhập gói” ở đó.
          Nhập gói là <b>gộp</b> (không ghi đè như khôi phục sao lưu): sửa ở cả hai máy cũng không mất gì, bản sửa sau thắng.
          Gói chỉ chứa những gì máy kia chưa có.
        </span>
        <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
          <li>Máy mới: ở máy đang có dữ liệu bấm <b>Xuất gói đầy đủ</b> → nhập ở máy mới.</li>
          <li>Ở máy mới bấm <b>Xuất gói</b> cho máy kia → nhập lại ở máy kia (để hai bên xác nhận đã có của nhau).</li>
          <li>Những lần sau: máy nào vừa nhập liệu thì xuất gói cho máy kia. Bảng bên dưới cho biết còn bao nhiêu thay đổi chưa gửi.</li>
        </ol>
        <div className="setting">
          <div className="grow stack tight">
            <label className="strong" htmlFor="sync-name">Tên trình duyệt này</label>
            <span className="xs muted">Hiện ở máy kia để biết gói đến từ đâu · mã máy {device.id.slice(0, 8)}</span>
          </div>
          <input id="sync-name" className="input" style={{ width: 240 }} value={nameText ?? device.name} onChange={(e) => setNameText(e.target.value)}
            onBlur={() => { if (nameText !== null && nameText.trim() !== device.name) run(() => setDeviceName(db, nameText), 'Đã đổi tên máy'); setNameText(null); }} />
        </div>
        <div className="setting">
          <div className="grow stack tight">
            <label className="strong" htmlFor="sync-pw">Mật khẩu đồng bộ (không bắt buộc)</label>
            <span className="xs muted">Có mật khẩu thì gói được mã hóa (AES-GCM) — nên dùng khi gửi qua Zalo / email / Drive. Không lưu lại; nhập giống nhau ở các máy.</span>
          </div>
          <input id="sync-pw" type="password" className="input" style={{ width: 240 }} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={() => exportFor(null)}>Xuất gói đầy đủ (máy mới)</button>
          <label className="btn primary">
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
            <span className="small">Gói từ <b>{pending.fromName || 'máy khác'}</b> đã được mã hóa. Nhập mật khẩu đồng bộ ở trên rồi bấm:</span>
            <div className="row"><button type="button" className="btn sm primary" disabled={!password} onClick={() => doImport(pending.text, password)}>Mở gói</button>
              <button type="button" className="btn sm" onClick={() => setPending(null)}>Hủy</button></div>
          </div>
        )}
        {report && <Report report={report} onClose={() => setReport(null)} />}
      </section>

      <section className="card stack">
        <h2>Đã đồng bộ với</h2>
        {peers.length === 0 ? <Empty>Chưa đồng bộ với trình duyệt nào. Nhập một gói từ máy khác để bắt đầu.</Empty> : (
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
                  <button type="button" className="btn sm primary" onClick={() => exportFor(p.id, p.name)}>Xuất gói cho {p.name}</button>
                  <button type="button" className="btn sm" onClick={() => {
                    if (confirm(`Quên “${p.name}”? Lần sau gửi cho máy đó sẽ là gói đầy đủ. Dữ liệu không bị xóa.`)) run(() => forgetPeer(db, p.id), 'Đã quên máy');
                  }}>Quên</button>
                </span>
              </div>
            ))}
          </div>
        )}
        <span className="xs muted">
          “Chưa gửi” chỉ tính các thay đổi máy kia chưa có — những gì vừa nhận từ chính máy đó không gửi ngược lại.
          Gói bị thất lạc cũng không sao: máy kia chưa xác nhận thì lần sau vẫn gửi lại.
        </span>
      </section>
    </div>
  );
}

function Report({ report, onClose }: { report: ImportReport; onClose: () => void }) {
  const parts = Object.entries(report.perTable).map(([t, s]) => `${s!.added + s!.updated} ${TABLE_NAME[t] ?? t}`);
  return (
    <div className={`summary ${report.warnings.length ? 'warn' : 'ok'} stack tight`} aria-live="polite">
      <div className="row between">
        <span className="strong">Đã gộp gói từ {report.from.name}</span>
        <button type="button" className="btn sm" onClick={onClose}>Đóng</button>
      </div>
      <span className="small">
        {report.added + report.updated + report.removed === 0 && !report.settingsUpdated ? 'Không có gì mới — hai bên đã giống nhau.'
          : `${report.added} bản ghi mới, ${report.updated} cập nhật${report.removed ? `, ${report.removed} đã xóa` : ''}${parts.length ? ` (${parts.join(', ')})` : ''}${report.settingsUpdated ? ' · cập nhật cài đặt chung' : ''}.`}
        {report.skipped ? ` Bỏ qua ${report.skipped} bản đã có hoặc cũ hơn.` : ''}
      </span>
      {report.fixes.map((f) => <span className="small" key={f}>Đã tự sửa: {f}</span>)}
      {report.warnings.map((w) => <span className="small c-give" key={w}>Cần xem lại: {w}</span>)}
    </div>
  );
}
