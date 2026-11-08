import { useState, type FormEvent, type ReactNode } from 'react';
import { db, type Income } from '../db/schema';
import { addPerson } from '../domain/catalog';
import { saveIncome, updateIncome } from '../domain/income';
import { today } from '../domain/period';
import { parseAmount } from '../domain/split';
import { rootOf, type Index } from '../domain/stats';
import { money, useMask, useRun } from './format';
import { Avatar } from './kit';
import { CategoryPicker } from './pickers';

const toText = (n: number) => (n ? n.toLocaleString('vi-VN') : '');

/** BR-20: nhập / sửa một khoản thu nhập. `src` có id + `edit` = sửa; không có `edit` = nhân bản. */
export default function IncomeForm({ ix, src, edit, onDone, header }: {
  ix: Index; src?: Income; edit?: boolean; onDone: () => void; header?: ReactNode;
}) {
  const run = useRun();
  const mask = useMask();
  const cat = src ? ix.category.get(src.categoryId) : undefined;
  const [amountText, setAmountText] = useState(toText(src?.amount ?? 0));
  const [date, setDate] = useState(edit && src ? src.date : today());
  const [rootId, setRootId] = useState(src ? rootOf(ix, src.categoryId)?.id ?? '' : ix.incomeRoots[0]?.id ?? '');
  const [subId, setSubId] = useState(cat?.parentId ? cat.id : '');
  const [title, setTitle] = useState(src?.title ?? '');
  const [personId, setPersonId] = useState<string | null>(src?.personId ?? null);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const amount = parseAmount(amountText);
  /** Phần “cho luôn” của một lần nhận: số tiền và người cho gắn với lần nhận đó, không sửa ở đây. */
  const linked = !!(edit && src?.settlementId);
  const people = ix.people.filter((p) => !p.archived || p.id === personId);
  const canSave = amount > 0 && !!rootId && !saving;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    const input = { date, categoryId: subId || rootId, amount, title, personId };
    const ok = edit && src
      ? await run(() => updateIncome(db, src.id, input), 'Đã lưu thay đổi')
      : await run(() => saveIncome(db, input), `Đã ghi thu nhập ${mask(money(amount))}`);
    setSaving(false);
    if (ok) onDone();
  };
  const addNew = async () => {
    const id = await run(() => addPerson(db, newName, 'give'));
    if (id) { setPersonId(id); setNewName(''); }
  };

  return (
    <form className="stack" style={{ gap: 16 }} onSubmit={submit}>
      {header}
      <div className="row" style={{ alignItems: 'flex-end', gap: 16 }}>
        <div className="field" style={{ flex: '2 1 240px' }}>
          <label htmlFor="inc-amt">Số tiền nhận được</label>
          <input id="inc-amt" className="input big c-income" inputMode="decimal" autoComplete="off" autoFocus placeholder="15tr"
            value={amountText} onChange={(e) => setAmountText(e.target.value)} onBlur={() => amount > 0 && setAmountText(toText(amount))} aria-describedby="inc-hint" readOnly={linked} />
          <span id="inc-hint" className="xs muted">{linked ? 'Phần cho luôn khi trả tiền: muốn đổi số tiền hãy xóa lần nhận và ghi lại' : amount > 0 ? `= ${money(amount)}` : 'Gõ tắt: 15tr, 500k'}</span>
        </div>
        <div className="field" style={{ flex: '1 1 160px' }}>
          <label htmlFor="inc-day">Ngày</label>
          <input id="inc-day" className="input" type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
          <span className="xs muted">&nbsp;</span>
        </div>
      </div>
      <CategoryPicker ix={ix} income rootId={rootId} subId={subId} onRoot={(id) => { setRootId(id); setSubId(''); }} onSub={setSubId} />
      <div className="field">
        <label htmlFor="inc-note">Ghi chú</label>
        <input id="inc-note" className="input" placeholder="Lương tháng 11, Mẹ cho tiền Tết…" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      {!linked && <div className="field">
        <span className="label" id="inc-person">Ai cho? (không bắt buộc)</span>
        <div className="chips" role="group" aria-labelledby="inc-person">
          <button type="button" className="chip sm" aria-pressed={personId === null} onClick={() => setPersonId(null)}>Không gắn người</button>
          {people.map((p) => (
            <button type="button" key={p.id} className="chip sm" aria-pressed={personId === p.id} onClick={() => setPersonId(p.id)}>
              <Avatar person={p} size={22} />{p.name}
            </button>
          ))}
        </div>
        <div className="row nowrap" style={{ gap: 8, maxWidth: 420 }}>
          <label className="sr-only" htmlFor="inc-new">Thêm người mới</label>
          <input id="inc-new" className="input" placeholder="+ Thêm người, ví dụ: Mẹ" value={newName} onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addNew(); } }} />
          <button type="button" className="btn" onClick={addNew} disabled={!newName.trim()}>Thêm</button>
        </div>
      </div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onDone}>Hủy</button>
        <button type="submit" className="btn primary" disabled={!canSave}>{edit ? 'Lưu' : 'Lưu thu nhập'}</button>
      </div>
    </form>
  );
}
