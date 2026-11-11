import { useState, type FormEvent, type ReactNode } from 'react';
import { db, type Income } from '../db/schema';
import { addPerson } from '../domain/catalog';
import { saveIncome, updateIncome } from '../domain/income';
import { today } from '../domain/period';
import { parseAmount } from '../domain/split';
import { owedTo, rootOf, type Index } from '../domain/stats';
import { money, useMask, useRun } from './format';
import { AmountKeys, Avatar, Segmented, Switch } from './kit';
import { CategoryPicker } from './pickers';

const toText = (n: number) => (n ? n.toLocaleString('vi-VN') : '');

/** BR-20: add / edit an income. `src` with id + `edit` = edit; without `edit` = duplicate. */
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
  // UC-16: use part of the income right away to repay a debt (new incomes only).
  const creditors = edit ? [] : ix.people.map((p) => ({ p, owed: owedTo(ix, p.id) })).filter((x) => x.owed > 0);
  const [repayOn, setRepayOn] = useState(false);
  const [repayTo, setRepayTo] = useState(creditors[0]?.p.id ?? '');
  const [repayText, setRepayText] = useState('');
  const [repayMode, setRepayMode] = useState<'hold' | 'transfer'>('hold');
  const owedSel = creditors.find((c) => c.p.id === repayTo)?.owed ?? 0;
  const repayAmt = repayOn ? (repayText.trim() ? parseAmount(repayText) : Math.min(owedSel, amount)) : 0;
  const repayBad = repayOn && (repayAmt <= 0 || repayAmt > owedSel || repayAmt > amount);
  /** A gifted surplus of a payment: its amount and giver are tied to that payment and are not edited here. */
  const linked = !!(edit && src?.settlementId);
  const people = ix.people.filter((p) => !p.archived || p.id === personId);
  const canSave = amount > 0 && !!rootId && !saving && !repayBad;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    const input = { date, categoryId: subId || rootId, amount, title, personId };
    const ok = edit && src
      ? await run(() => updateIncome(db, src.id, input), 'Đã lưu thay đổi')
      : await run(() => saveIncome(db, input, repayOn ? { personId: repayTo, amount: repayAmt, mode: repayMode } : undefined),
        `Đã ghi thu nhập ${mask(money(amount))}${repayOn ? ` · trả nợ ${money(repayAmt)}` : ''}`);
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
          {!linked && <AmountKeys onAdd={(k) => setAmountText((t) => t + k)} />}
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
      {creditors.length > 0 && (
        <div className="card stack tight" style={{ padding: 14 }}>
          <div className="setting" style={{ borderTop: 0, padding: 0 }}>
            <div className="grow stack tight">
              <span className="strong small">Dùng để trả nợ</span>
              <span className="xs muted">Tính là tiền ra (dòng “Trả nợ”) — “Còn lại” và Số dư của tôi giảm theo.</span>
            </div>
            <Switch label="Dùng để trả nợ" checked={repayOn} onChange={setRepayOn} />
          </div>
          {repayOn && (
            <>
              <div className="chips" role="group" aria-label="Trả nợ cho ai">
                {creditors.map(({ p, owed }) => (
                  <button type="button" key={p.id} className="chip sm" aria-pressed={repayTo === p.id} onClick={() => { setRepayTo(p.id); setRepayText(''); }}>
                    <Avatar person={p} size={22} />{p.name} · nợ {money(owed)}
                  </button>
                ))}
              </div>
              <div className="field">
                <label htmlFor="inc-repay">Số tiền trả</label>
                <input id="inc-repay" className="input" inputMode="decimal" placeholder={toText(Math.min(owedSel, amount)) || 'Trả hết'}
                  value={repayText} onChange={(e) => setRepayText(e.target.value)} onBlur={() => repayAmt > 0 && setRepayText(toText(repayAmt))} />
              </div>
              <Segmented label="Cách trả" value={repayMode} onChange={setRepayMode}
                options={[['hold', 'Giữ lại cho họ'], ['transfer', 'Chuyển khoản trả']]} />
              <span className="xs muted">
                {repayMode === 'hold'
                  ? 'Tiền vẫn nằm trong tài khoản của bạn nhưng thành tiền đang giữ của họ (sau này chi hộ sẽ trừ vào đây).'
                  : 'Bạn chuyển khoản trả luôn: số dư tài khoản giảm.'}
              </span>
              {repayAmt > owedSel && <span className="small c-give">Chỉ đang nợ {money(owedSel)}.</span>}
              {repayAmt > amount && amount > 0 && <span className="small c-give">Số trả vượt khoản thu nhập.</span>}
              {!repayBad && <span className="small">Sau khi lưu: còn nợ <b>{money(owedSel - repayAmt)}</b></span>}
            </>
          )}
        </div>
      )}
      <div className="row save-bar" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onDone}>Hủy</button>
        <button type="submit" className="btn primary" disabled={!canSave}>{edit ? 'Lưu' : 'Lưu thu nhập'}</button>
      </div>
    </form>
  );
}
