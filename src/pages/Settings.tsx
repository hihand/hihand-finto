import { lazy, Suspense, useState } from 'react';
import { db, type Category, type Person } from '../db/schema';
import { importBackup } from '../db/backup';
import {
  addCategory, addPerson, deleteGroup, saveGroup, addTagToCategory, deleteCategory, removeTagFromCategory, renameCategory, setCountsAsMine, updatePerson,
} from '../domain/catalog';
import type { Index } from '../domain/stats';
import { useTheme } from '../theme';
import { useIndex } from '../ui/data';
import { Avatar, Icon, Segmented, Switch } from '../ui/kit';
import { useRun } from '../ui/format';
import { downloadBackup } from '../ui/download';
// Xuất Excel (kèm thư viện nén) chỉ tải khi mở hộp thoại, để bản chính nhẹ hơn.
const ExportDialog = lazy(() => import('../ui/ExportDialog'));
import { fmtDate, today } from '../domain/period';
import { setOpeningBalance } from '../domain/income';
import { parseAmount } from '../domain/split';
import { balanceAt, debtSummary } from '../domain/stats';
import { money, useMask } from '../ui/format';
import { useSearchParams } from 'react-router-dom';

type Tab = 'cats' | 'income' | 'people' | 'general';

export default function SettingsPage() {
  const ix = useIndex();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get('tab') === 'chung' ? 'general' : 'cats');
  if (!ix) return <p className="muted">Đang tải…</p>;
  const TABS: [Tab, string][] = [['cats', 'Danh mục chi & tag'], ['income', 'Danh mục thu'], ['people', 'Mọi người'], ['general', 'Chung & dữ liệu']];
  return (
    <>
      <h1>Cài đặt</h1>
      <div className="tabs" role="tablist" aria-label="Mục cài đặt">
        {TABS.map(([k, l]) => <button type="button" role="tab" key={k} aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'cats' && <Categories key="cats" ix={ix} />}
      {tab === 'income' && <Categories key="income" ix={ix} income />}
      {tab === 'people' && <PeopleSettings ix={ix} />}
      {tab === 'general' && <General ix={ix} />}
    </>
  );
}

/** Tên sửa tại chỗ. */
function InlineName({ value, onSave, label }: { value: string; onSave: (v: string) => Promise<unknown>; label: string }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(value);
  if (!edit) return (
    <button type="button" className="btn sm" onClick={() => { setV(value); setEdit(true); }} aria-label={`Đổi tên ${value}`}>Đổi tên</button>
  );
  const save = async () => { if ((await onSave(v)) !== undefined) setEdit(false); };
  return (
    <span className="row nowrap" style={{ gap: 6 }}>
      <input className="input" style={{ height: 36, width: 180 }} aria-label={label} autoFocus value={v} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEdit(false); }} />
      <button type="button" className="btn sm primary" onClick={save}>Lưu</button>
    </span>
  );
}

function AddRow({ placeholder, onAdd, label }: { placeholder: string; onAdd: (v: string) => Promise<unknown>; label: string }) {
  const [v, setV] = useState('');
  const add = async () => { if ((await onAdd(v)) !== undefined) setV(''); };
  return (
    <div className="row nowrap" style={{ gap: 8 }}>
      <input className="input" aria-label={label} placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
      <button type="button" className="btn" disabled={!v.trim()} onClick={add}>Thêm</button>
    </div>
  );
}

/** BR-14 / BR-21: danh mục chi (có tag, công tắc Chi của tôi) và danh mục thu. */
function Categories({ ix, income }: { ix: Index; income?: boolean }) {
  const run = useRun();
  const roots = income ? ix.incomeRoots : ix.roots;
  const [sel, setSel] = useState<string>(roots[0]?.id ?? '');
  const root: Category | undefined = roots.find((c) => c.id === sel) ?? roots[0];
  const subs = root ? ix.childrenOf.get(root.id) ?? [] : [];
  const tags = root ? ix.tagsOfCategory.get(root.id) ?? [] : [];
  const inCat = (id: string, catId: string) => id === catId || ix.category.get(id)?.parentId === catId;
  const used = (catId: string) => ix.txs.some((t) => inCat(t.categoryId, catId)) || ix.incomes.some((r) => inCat(r.categoryId, catId));

  const del = (c: Category) => {
    const msg = used(c.id)
      ? `Xóa “${c.name}”? Giao dịch cũ vẫn giữ tên danh mục này, chỉ không chọn được khi nhập mới.`
      : `Xóa “${c.name}”${c.parentId ? '' : ' và các danh mục con'}?`;
    if (confirm(msg)) run(() => deleteCategory(db, c.id), 'Đã xóa danh mục');
  };

  return (
    <div className="cols">
      <section className="card stack col-side" style={{ padding: 16 }}>
        <span className="label" style={{ padding: '4px 8px' }}>{income ? 'Danh mục thu nhập' : 'Danh mục chi'}</span>
        <div className="stack" style={{ gap: 4 }}>
          {roots.map((c) => (
            <button type="button" key={c.id} className="pick" aria-pressed={c.id === root?.id} onClick={() => setSel(c.id)}>
              <span className="avatar" style={{ width: 40, height: 40, ['--av' as string]: income ? 'var(--income)' : 'var(--primary)' }} aria-hidden="true"><Icon name={c.icon} size={18} /></span>
              <span className="grow stack tight">
                <span className="title">{c.name}</span>
                <span className="meta">{(ix.childrenOf.get(c.id) ?? []).length} danh mục con{income ? '' : ` · ${(ix.tagsOfCategory.get(c.id) ?? []).length} tag${c.countsAsMine ? '' : ' · không tính vào Chi của tôi'}`}</span>
              </span>
            </button>
          ))}
        </div>
        <AddRow label="Tên danh mục mới" placeholder="+ Danh mục mới" onAdd={(v) => run(async () => setSel(await addCategory(db, v, null, income ? 'wallet' : 'dots', income ? 'income' : 'expense')), 'Đã thêm danh mục')} />
      </section>

      {root && (
        <section className="card stack col-main">
          <div className="row" style={{ gap: 12 }}>
            <span className="avatar" style={{ width: 48, height: 48, ['--av' as string]: 'var(--primary)' }} aria-hidden="true"><Icon name={root.icon} size={22} /></span>
            <div className="grow stack tight"><h2>{root.name}</h2><span className="xs muted">{income ? 'Danh mục thu nhập · dùng khi ghi lương, thưởng, được cho…' : 'Tag chỉ hiện khi chọn danh mục này lúc nhập chi tiêu'}</span></div>
            <InlineName label="Tên danh mục" value={root.name} onSave={(v) => run(() => renameCategory(db, root.id, v), 'Đã đổi tên')} />
            <button type="button" className="btn sm danger" onClick={() => del(root)}>Xóa</button>
          </div>

          {!income && <div className="setting">
            <div className="grow stack tight">
              <span className="strong">Tính vào “Chi của tôi”</span>
              <span className="xs muted">Tắt cho danh mục như Chuyển tiền, để không làm lệch thống kê cá nhân</span>
            </div>
            <Switch label="Tính vào Chi của tôi" checked={root.countsAsMine} onChange={(v) => run(() => setCountsAsMine(db, root.id, v))} />
          </div>}

          <div className="stack" style={{ gap: 8 }}>
            <h3>Danh mục con ({subs.length})</h3>
            <div className="list">
              {subs.map((s) => (
                <div className="item" key={s.id} style={{ minHeight: 52 }}>
                  <span className="grow strong small">{s.name}</span>
                  <InlineName label={`Tên mới cho ${s.name}`} value={s.name} onSave={(v) => run(() => renameCategory(db, s.id, v), 'Đã đổi tên')} />
                  <button type="button" className="icon-btn" aria-label={`Xóa ${s.name}`} onClick={() => del(s)}><Icon name="x" size={18} /></button>
                </div>
              ))}
            </div>
            <AddRow label="Tên danh mục con mới" placeholder={income ? '+ Danh mục con, ví dụ: Lì xì' : '+ Danh mục con, ví dụ: Sữa rửa mặt'} onAdd={(v) => run(() => addCategory(db, v, root.id), 'Đã thêm danh mục con')} />
          </div>

          {!income && <div className="stack" style={{ gap: 8 }}>
            <h3>Tag ({tags.length})</h3>
            <div className="chips">
              {tags.map((t) => (
                <span className="tagchip" key={t.id}>#{t.name}
                  <button type="button" aria-label={`Bỏ tag ${t.name}`} onClick={() => run(() => removeTagFromCategory(db, root.id, t.id))}><Icon name="x" size={14} /></button>
                </span>
              ))}
            </div>
            <AddRow label="Tên tag mới" placeholder="Tên tag mới, ví dụ: ăn khuya" onAdd={(v) => run(() => addTagToCategory(db, root.id, v), 'Đã thêm tag')} />
          </div>}
        </section>
      )}
    </div>
  );
}

function PeopleSettings({ ix }: { ix: Index }) {
  const run = useRun();
  const [showArchived, setShowArchived] = useState(false);
  const list = ix.people.filter((p) => showArchived || !p.archived);
  const set = (p: Person, patch: Parameters<typeof updatePerson>[2]) => run(() => updatePerson(db, p.id, patch));
  const debtOf = new Map(debtSummary(ix).map((d) => [d.personId, d]));
  /** Ẩn người còn công nợ: hỏi lại trước (khoản nợ vẫn còn, chỉ ẩn khỏi danh sách chọn). */
  const archive = (p: Person) => {
    const d = debtOf.get(p.id);
    if (!p.archived && d && !window.confirm(`${p.name} vẫn còn công nợ${d.iOwe ? ` · bạn nợ ${money(d.iOwe)}` : ''}${d.theyOwe ? ` · nợ bạn ${money(d.theyOwe)}` : ''}. Vẫn ẩn?`)) return;
    set(p, { archived: !p.archived });
  };
  return (
    <div className="cols">
      <section className="card stack col-main">
        <div className="row between"><h2>Mọi người</h2><span className="xs muted">Mặc định khi chia tiền</span></div>
        {list.length === 0 && <span className="muted small">Danh bạ trống. Thêm người dưới đây hoặc ngay khi nhập chi tiêu.</span>}
        <div className="list">
          {list.map((p) => (
            <div className="item" key={p.id} style={{ flexWrap: 'wrap', opacity: p.archived ? 0.6 : 1 }}>
              <Avatar person={p} />
              <span className="grow strong" style={{ minWidth: 100 }}>{p.name}{p.archived ? ' (ẩn)' : ''}</span>
              <span className="mini-seg" role="group" aria-label={`Mặc định cho ${p.name}`}>
                <button type="button" className="owe" aria-pressed={p.defaultType === 'owe'} onClick={() => set(p, { defaultType: 'owe' })}>Đòi lại</button>
                <button type="button" className="give" aria-pressed={p.defaultType === 'give'} onClick={() => set(p, { defaultType: 'give' })}>Cho</button>
              </span>
              <InlineName label={`Tên mới cho ${p.name}`} value={p.name} onSave={(v) => set(p, { name: v })} />
              <button type="button" className="btn sm" onClick={() => archive(p)}>{p.archived ? 'Hiện lại' : 'Ẩn'}</button>
            </div>
          ))}
        </div>
        <AddRow label="Tên người mới" placeholder="+ Thêm người" onAdd={(v) => run(() => addPerson(db, v), 'Đã thêm')} />
        <label className="row small muted" style={{ gap: 8 }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Hiện cả người đã ẩn
        </label>
      </section>
      <Groups ix={ix} />
    </div>
  );
}

/** BR-18: nhóm hay đi cùng — chọn nhóm khi nhập chi tiêu là tick sẵn cả nhóm. */
function Groups({ ix }: { ix: Index }) {
  const run = useRun();
  const [edit, setEdit] = useState<{ id?: string; name: string; memberIds: string[] } | null>(null);
  const people = ix.people.filter((p) => !p.archived || edit?.memberIds.includes(p.id));
  const save = async () => {
    if (!edit) return;
    const ok = await run(() => saveGroup(db, edit), edit.id ? 'Đã lưu nhóm' : 'Đã tạo nhóm');
    if (ok) setEdit(null);
  };
  const toggle = (id: string) => edit && setEdit({ ...edit, memberIds: edit.memberIds.includes(id) ? edit.memberIds.filter((x) => x !== id) : [...edit.memberIds, id] });
  return (
    <section className="card stack col-side">
      <h2>Nhóm hay đi cùng</h2>
      <span className="small muted">Chọn nhóm khi nhập chi tiêu là tick sẵn cả nhóm.</span>
      {ix.groups.map(({ group, memberIds }) => edit?.id === group.id ? null : (
        <div className="group-card" key={group.id}>
          <div className="row between">
            <span className="strong">{group.name}</span>
            <span className="row" style={{ gap: 6 }}>
              <button type="button" className="btn sm" onClick={() => setEdit({ id: group.id, name: group.name, memberIds })}>Sửa</button>
              <button type="button" className="icon-btn" aria-label={`Xóa nhóm ${group.name}`}
                onClick={() => confirm(`Xóa nhóm “${group.name}”?`) && run(() => deleteGroup(db, group.id), 'Đã xóa nhóm')}><Icon name="x" size={18} /></button>
            </span>
          </div>
          <span className="small muted">{memberIds.map((id) => ix.person.get(id)?.name).join(', ') || 'Chưa có ai'}</span>
        </div>
      ))}
      {edit ? (
        <div className="group-card">
          <div className="field">
            <label htmlFor="g-name">Tên nhóm</label>
            <input id="g-name" className="input" autoFocus placeholder="Hội bạn thân" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          </div>
          <span className="label" id="g-members">Thành viên ({edit.memberIds.length})</span>
          <div className="chips" role="group" aria-labelledby="g-members">
            {people.map((p) => (
              <button type="button" key={p.id} className="chip sm" aria-pressed={edit.memberIds.includes(p.id)} onClick={() => toggle(p.id)}>{p.name}</button>
            ))}
          </div>
          {people.length === 0 && <span className="small muted">Thêm người trước, rồi tạo nhóm.</span>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn sm" onClick={() => setEdit(null)}>Hủy</button>
            <button type="button" className="btn sm primary" onClick={save}>Lưu nhóm</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn ghost" onClick={() => setEdit({ name: '', memberIds: [] })}>+ Tạo nhóm</button>
      )}
      <span className="xs muted">Ẩn một người chỉ bỏ họ khỏi danh sách chọn; các khoản cũ vẫn giữ nguyên.</span>
    </section>
  );
}

/** BR-23: số dư ban đầu — số tiền đang có tại một ngày; số dư sau đó = số này + dòng tiền. */
function OpeningBalance({ ix }: { ix: Index }) {
  const run = useRun();
  const s = ix.snap.settings;
  const [text, setText] = useState(s?.openingBalance !== undefined ? s.openingBalance.toLocaleString('vi-VN') : '');
  const [date, setDate] = useState(s?.openingDate ?? today());
  const amount = /^-/.test(text.trim()) ? -parseAmount(text.trim().slice(1)) : parseAmount(text);
  const balance = balanceAt(ix);
  const mask = useMask();
  return (
    <div className="setting" style={{ alignItems: 'flex-end' }}>
      <div className="grow stack tight" style={{ minWidth: 220, alignSelf: 'center' }}>
        <span className="strong">Số dư ban đầu</span>
        <span className="xs muted">
          Số tiền bạn đang có (tiền mặt + tài khoản) vào ngày bắt đầu. Giao dịch trước ngày này không tính lại.
          {balance !== null ? ` Số dư hiện tại: ${mask(money(balance))}.` : ''}
        </span>
      </div>
      <div className="field" style={{ width: 170 }}>
        <label htmlFor="ob-amt">Số tiền</label>
        <input id="ob-amt" className="input" inputMode="decimal" placeholder="5tr" value={text} onChange={(e) => setText(e.target.value)}
          type={mask('x') !== 'x' ? 'password' : 'text'} autoComplete="off" />
      </div>
      <div className="field" style={{ width: 170 }}>
        <label htmlFor="ob-date">Tính từ ngày</label>
        <input id="ob-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <button type="button" className="btn primary" disabled={!text.trim()}
        onClick={() => run(() => setOpeningBalance(db, amount, date), `Đã đặt số dư ban đầu ${money(amount)}`)}>Lưu</button>
    </div>
  );
}

function General({ ix }: { ix: Index }) {
  const run = useRun();
  const { pref, setTheme } = useTheme();
  const s = ix.snap.settings;
  const update = (patch: Partial<NonNullable<typeof s>>) => run(() => db.settings.update('settings', patch));

  const [exporting, setExporting] = useState(false);
  const download = () => run(downloadBackup);
  const restore = async (file?: File) => {
    if (!file) return;
    if (!confirm('Khôi phục sẽ thay toàn bộ dữ liệu hiện có. Tiếp tục?')) return;
    run(async () => importBackup(await file.text()), 'Đã khôi phục dữ liệu');
  };

  return (
    <section className="card" style={{ maxWidth: 860 }}>
      <OpeningBalance ix={ix} />
      <div className="setting">
        <div className="grow stack tight"><span className="strong">Ẩn thu nhập & số dư khi mở app</span><span className="xs muted">Mỗi lần mở app, thu nhập, số dư, còn lại và các khoản thu hiện thành •••••. Bấm nút con mắt cạnh tên app để xem; lần mở sau tự ẩn lại</span></div>
        <Switch label="Ẩn thu nhập và số dư khi mở app" checked={s?.hideOnOpen ?? true} onChange={(v) => update({ hideOnOpen: v })} />
      </div>
      <div className="setting">
        <div className="grow stack tight"><span className="strong">Giao diện</span><span className="xs muted">Mặc định Tối (Midnight Lilac), Sáng là Lavender Cloud</span></div>
        <div style={{ width: 320, maxWidth: '100%' }}>
          <Segmented label="Giao diện" value={pref} onChange={setTheme} options={[['dark', 'Tối'], ['light', 'Sáng'], ['system', 'Theo hệ thống']]} />
        </div>
      </div>
      <div className="setting">
        <div className="grow stack tight"><label className="strong" htmlFor="startday">Ngày bắt đầu tháng thống kê</label><span className="xs muted">Ví dụ chọn ngày 10 nếu bạn nhận lương ngày 10</span></div>
        <select id="startday" className="input" style={{ width: 140 }} value={s?.monthStartDay ?? 1} onChange={(e) => update({ monthStartDay: Number(e.target.value) })}>
          {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>Ngày {d}</option>)}
        </select>
      </div>
      <div className="setting">
        <div className="grow stack tight"><span className="strong">Tự trừ vào tiền đang giữ</span><span className="xs muted">Khoản Đòi lại mới tự trừ vào tiền người đó gửi trước; tắt được từng giao dịch</span></div>
        <Switch label="Tự trừ vào tiền đang giữ" checked={s?.autoApplyCredit ?? true} onChange={(v) => update({ autoApplyCredit: v })} />
      </div>
      <div className="setting">
        <div className="grow stack tight"><span className="strong">Cuối tháng ghi chú tiền dư</span><span className="xs muted">Tự ghi “An chuyển dư 60k (tháng 11)” cho người còn tiền đang giữ khi sang kỳ mới</span></div>
        <Switch label="Cuối tháng ghi chú tiền dư" checked={s?.monthEndNote ?? true} onChange={(v) => update({ monthEndNote: v })} />
      </div>
      <div className="setting">
        <div className="grow stack tight"><span className="strong">Tiền tệ</span><span className="xs muted">Hiển thị dạng 360.000đ, nhập nhanh 360k</span></div>
        <span className="strong">VND (đ)</span>
      </div>
      <div className="setting">
        <div className="grow stack tight">
          <span className="strong">Dữ liệu</span>
          <span className="xs muted">
            Dữ liệu chỉ nằm trong trình duyệt này. Hãy sao lưu định kỳ.
            {s?.lastBackupAt ? ` Lần sao lưu gần nhất: ${fmtDate(s.lastBackupAt.slice(0, 10))}.` : ' Chưa sao lưu lần nào.'}
          </span>
        </div>
        <button type="button" className="btn" onClick={() => setExporting(true)}>Xuất Excel</button>
        <button type="button" className="btn primary" onClick={download}>Sao lưu (JSON)</button>
        <label className="btn">
          Khôi phục từ file
          <input type="file" accept="application/json" hidden onChange={(e) => { restore(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>
      {exporting && <Suspense fallback={null}><ExportDialog ix={ix} onClose={() => setExporting(false)} /></Suspense>}
    </section>
  );
}
