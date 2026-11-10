import { useState } from 'react';
import { db } from '../db/schema';
import { addPerson } from '../domain/catalog';
import {
  borrow, deleteAllocations, deletePayable, deleteRepayments, forgiveAll, heldToDebt, offsetDebts, repay, setOpening, waiveDebt,
} from '../domain/debt';
import { fmtDate, today } from '../domain/period';
import { parseAmount } from '../domain/split';
import { creditOf, debtLedger, openingOf, outstanding, owedTo, type Index } from '../domain/stats';
import { money, short, useMask, useRun, useToast } from './format';
import { Avatar, Empty, Modal, Segmented } from './kit';

const toText = (n: number) => (n ? n.toLocaleString('vi-VN') : '');
export type DebtMode = 'book' | 'opening' | 'repay' | 'waive' | 'forgive' | 'offset' | 'borrow' | 'fromHeld';

const HINT: Record<Exclude<DebtMode, 'book' | 'opening'>, string> = {
  repay: 'Trả bớt khoản bạn đang nợ. Tính là tiền ra (dòng “Trả nợ”) nếu là nợ đầu kỳ.',
  waive: 'Người đó không lấy lại khoản bạn nợ. Nợ đầu kỳ: không tính là thu nhập. Nợ phát sinh trong app: tính như được cho.',
  forgive: 'Bạn không đòi phần họ đang nợ nữa, trừ dần từ khoản cũ nhất. Phần này thành Cho đi (khoản đầu kỳ không tính vào chi tiêu kỳ).',
  offset: 'Hai bên đang nợ nhau: cấn trừ số nhỏ hơn để huề.',
  borrow: 'Người đó chuyển tiền cho bạn vay: tài khoản tăng, bạn nợ họ. Không phải thu nhập.',
  fromHeld: 'Bạn đã tiêu mất một phần tiền đang giữ của họ: chuyển phần đó thành khoản bạn nợ.',
};

/**
 * UC-14..19: công nợ hai chiều với một người — sổ nợ, số đầu kỳ, trả nợ, được xóa nợ, xóa nợ cho họ, cấn trừ, vay, ứng tiền giữ.
 * Không truyền `personId` thì cho chọn người trước.
 */
export default function DebtModal({ ix, personId: initialPerson, initial = 'book', onClose }: {
  ix: Index; personId: string | null; initial?: DebtMode; onClose: () => void;
}) {
  const run = useRun();
  const toast = useToast();
  const mask = useMask();
  const [personId, setPersonId] = useState<string | null>(initialPerson);
  const [mode, setMode] = useState<DebtMode>(initial);
  const [text, setText] = useState(() => {
    if (!initialPerson) return '';
    const io = owedTo(ix, initialPerson);
    const to = outstanding(ix).find((o) => o.personId === initialPerson)?.amount ?? 0;
    return toText(initial === 'repay' || initial === 'waive' ? io : initial === 'forgive' ? to : initial === 'offset' ? Math.min(io, to) : 0);
  });
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [repayMode, setRepayMode] = useState<'hold' | 'transfer'>('hold');
  const [newName, setNewName] = useState('');
  const op = personId ? openingOf(ix, personId) : undefined;
  const [opening, setOpeningText] = useState(() => ({ held: toText(op?.held ?? 0), owedByMe: toText(op?.owedByMe ?? 0), owedToMe: toText(op?.owedToMe ?? 0), date: op?.date ?? today() }));

  const p = personId ? ix.person.get(personId) : undefined;
  const name = p?.name ?? '';
  const iOwe = personId ? owedTo(ix, personId) : 0;
  const theyOwe = personId ? outstanding(ix).find((o) => o.personId === personId)?.amount ?? 0 : 0;
  const held = personId ? creditOf(ix, personId) : 0;
  const book = personId ? debtLedger(ix, personId) : [];
  const amount = parseAmount(text);
  const max = mode === 'repay' || mode === 'waive' ? iOwe : mode === 'forgive' ? theyOwe : mode === 'offset' ? Math.min(iOwe, theyOwe) : mode === 'fromHeld' ? held : Infinity;
  const bad = amount <= 0 || amount > max;

  const pick = (id: string) => {
    setPersonId(id);
    const o = openingOf(ix, id);
    setOpeningText({ held: toText(o.held), owedByMe: toText(o.owedByMe), owedToMe: toText(o.owedToMe), date: o.date ?? today() });
  };
  const pickMode = (m: DebtMode) => {
    setMode(m);
    setNote('');
    const full = m === 'repay' || m === 'waive' ? iOwe : m === 'forgive' ? theyOwe : m === 'offset' ? Math.min(iOwe, theyOwe) : 0;
    setText(toText(full));
  };
  const addNew = async () => {
    const id = await run(() => addPerson(db, newName));
    if (id) { pick(id); setNewName(''); }
  };
  const undoable = (text: string, undo: () => Promise<unknown>) =>
    toast({ text, action: { label: 'Hoàn tác', run: () => run(undo) } }, 10_000);

  const submit = async () => {
    if (!personId) return;
    const n = note.trim() || undefined;
    try {
      if (mode === 'opening') {
        await setOpening(db, {
          personId, date: opening.date,
          held: parseAmount(opening.held), owedByMe: parseAmount(opening.owedByMe), owedToMe: parseAmount(opening.owedToMe),
        });
        toast({ text: `Đã lưu số đầu kỳ của ${name}` });
      } else if (bad) {
        return;
      } else if (mode === 'repay') {
        const ids = await repay(db, { personId, date, amount, mode: repayMode, note: n });
        undoable(`Đã trả nợ ${name} ${money(amount)}`, () => deleteRepayments(db, ids));
      } else if (mode === 'waive') {
        const ids = await waiveDebt(db, { personId, date, amount, note: n });
        undoable(`${name} đã xóa nợ ${money(amount)}`, () => deleteRepayments(db, ids));
      } else if (mode === 'forgive') {
        const ids = await forgiveAll(db, personId, amount, date);
        undoable(`Đã xóa nợ cho ${name} ${money(amount)} (Cho đi)`, () => deleteAllocations(db, ids));
      } else if (mode === 'offset') {
        const ids = await offsetDebts(db, personId, date, amount);
        undoable(`Đã cấn trừ ${money(amount)} với ${name}`, () => deleteAllocations(db, ids));
      } else {
        const id = await (mode === 'borrow' ? borrow : heldToDebt)(db, { personId, date, amount, note: n });
        undoable(mode === 'borrow' ? `Đã ghi vay ${name} ${money(amount)}` : `Đã chuyển ${money(amount)} tiền giữ thành khoản nợ`, () => deletePayable(db, id));
      }
      setMode('book');
      setText('');
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };

  if (!personId) {
    return (
      <Modal title="Công nợ" onClose={onClose}>
        <span className="small muted">Công nợ với ai? (ví dụ khoản bạn đang nợ Mẹ từ trước khi dùng app)</span>
        <div className="chips" role="group" aria-label="Chọn người">
          {ix.people.filter((x) => !x.archived).map((x) => (
            <button type="button" key={x.id} className="chip" onClick={() => pick(x.id)}><Avatar person={x} size={22} />{x.name}</button>
          ))}
        </div>
        <div className="row nowrap" style={{ gap: 8 }}>
          <label className="sr-only" htmlFor="debt-new">Thêm người mới</label>
          <input id="debt-new" className="input" placeholder="+ Thêm người, ví dụ: Mẹ" value={newName} onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addNew(); } }} />
          <button type="button" className="btn" onClick={addNew} disabled={!newName.trim()}>Thêm</button>
        </div>
      </Modal>
    );
  }

  const actions: [DebtMode, string][] = [
    ['book', 'Sổ nợ'], ['opening', 'Số đầu kỳ'],
    ...(iOwe > 0 ? [['repay', 'Trả nợ'], ['waive', 'Được xóa nợ']] as [DebtMode, string][] : []),
    ...(theyOwe > 0 ? [['forgive', 'Xóa nợ cho họ']] as [DebtMode, string][] : []),
    ...(iOwe > 0 && theyOwe > 0 ? [['offset', 'Cấn trừ']] as [DebtMode, string][] : []),
    ['borrow', 'Vay'],
    ...(held > 0 ? [['fromHeld', 'Ứng tiền giữ']] as [DebtMode, string][] : []),
  ];

  return (
    <Modal title={`Công nợ với ${name}`} onClose={onClose}>
      <div className="summary ok">
        <div className="row"><span>Tôi đang nợ {name}</span><span className="num c-give">{mask(money(iOwe))}</span></div>
        <div className="row"><span>{name} đang nợ tôi</span><span className="num c-owe">{money(theyOwe)}</span></div>
        {held > 0 && <div className="row small"><span>Đang giữ của {name}</span><span className="num c-income">{mask(money(held))}</span></div>}
      </div>
      <Segmented label="Việc cần làm" value={mode} onChange={pickMode} options={actions} />

      {mode === 'book' && (
        book.length === 0 ? <Empty>Chưa có khoản nợ nào với {name}. Bấm “Số đầu kỳ” để nhập khoản nợ từ trước khi dùng app.</Empty> : (
          <div className="list">
            {book.map((e) => (
              <div className="item" key={e.ref.id} style={{ minHeight: 48 }}>
                <span className="xs muted" style={{ width: 76 }}>{fmtDate(e.date)}</span>
                <span className="grow small">{e.label}</span>
                <span className={`num small ${e.delta > 0 ? 'c-give' : 'c-income'}`}>{e.delta > 0 ? '+' : '−'}{mask(short(Math.abs(e.delta)))}</span>
                <span className="num small muted" style={{ width: 90, textAlign: 'right' }}>{mask(money(e.balance))}</span>
              </div>
            ))}
          </div>
        )
      )}

      {mode === 'opening' && (
        <div className="stack" style={{ gap: 12 }}>
          <span className="small muted">
            Số tiền tại lúc bắt đầu dùng app. Không phải thu nhập, không đổi số dư tài khoản. Nợ đầu kỳ không trừ vào Số dư của tôi; khi trả thì tính là tiền ra.
          </span>
          {([['held', `Đang giữ của ${name} (tiền vẫn còn trong tài khoản)`], ['owedByMe', `Tôi đang nợ ${name} (đã tiêu mất)`], ['owedToMe', `${name} đang nợ tôi`]] as const).map(([k, label]) => (
            <div className="field" key={k}>
              <label htmlFor={`op-${k}`}>{label}</label>
              <input id={`op-${k}`} className="input" inputMode="decimal" placeholder="0" value={opening[k]}
                onChange={(e) => setOpeningText({ ...opening, [k]: e.target.value })}
                onBlur={() => setOpeningText((o) => ({ ...o, [k]: toText(parseAmount(o[k])) }))} />
            </div>
          ))}
          <div className="field" style={{ width: 170 }}>
            <label htmlFor="op-date">Tính tới ngày</label>
            <input id="op-date" type="date" className="input" value={opening.date} onChange={(e) => setOpeningText({ ...opening, date: e.target.value })} />
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setMode('book')}>Hủy</button>
            <button type="button" className="btn primary" onClick={submit}>Lưu số đầu kỳ</button>
          </div>
        </div>
      )}

      {mode !== 'book' && mode !== 'opening' && (
        <div className="stack" style={{ gap: 12 }}>
          <span className="small muted">{HINT[mode]}</span>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field grow">
              <label htmlFor="debt-amt">Số tiền</label>
              <input id="debt-amt" className="input" inputMode="decimal" autoFocus value={text}
                onChange={(e) => setText(e.target.value)} onBlur={() => amount > 0 && setText(toText(amount))} />
            </div>
            <div className="field" style={{ width: 170 }}>
              <label htmlFor="debt-date">Ngày</label>
              <input id="debt-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          {mode === 'repay' && (
            <>
              <Segmented label="Cách trả" value={repayMode} onChange={setRepayMode} options={[['hold', 'Giữ lại cho họ'], ['transfer', 'Chuyển khoản trả']]} />
              <span className="xs muted">
                {repayMode === 'hold'
                  ? `Tiền vẫn nằm trong tài khoản nhưng thành tiền đang giữ của ${name} (chi hộ sau này trừ vào đây).`
                  : `Bạn chuyển khoản trả ${name}: số dư tài khoản giảm.`}
              </span>
            </>
          )}
          {(mode === 'repay' || mode === 'waive' || mode === 'borrow' || mode === 'fromHeld') && (
            <div className="field"><label htmlFor="debt-note">Ghi chú</label>
              <input id="debt-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          )}
          {amount > max && <span className="small c-give">Tối đa {money(max)}.</span>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setMode('book')}>Hủy</button>
            <button type="button" className="btn primary" disabled={bad} onClick={submit}>Lưu</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
