import { useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../db/schema';
import { addPerson } from '../domain/catalog';
import { depositCredit, giftFromCredit, returnCredit } from '../domain/ledger';
import { fmtDate, today } from '../domain/period';
import { parseAmount } from '../domain/split';
import { creditOf, heldLedger, outstanding, type Index } from '../domain/stats';
import { money, short, useRun } from './format';
import { Avatar, Empty, Modal, Segmented, Switch } from './kit';

const toText = (n: number) => (n ? n.toLocaleString('vi-VN') : '');
type Mode = 'book' | 'in' | 'return' | 'gift';

/**
 * UC-11..13 + UC-09: sổ giữ hộ của một người và các việc với tiền giữ:
 * + nhận tiền giữ (gửi trước / nạp thêm), chi hộ (sang màn Thêm), trả lại, hoặc họ cho luôn (thành thu nhập).
 * Không truyền `personId` thì cho chọn người trước (ví dụ lần đầu Linh gửi tiền nhờ giữ).
 */
export default function HeldModal({ ix, personId: initialPerson, onClose, initial = 'book' }: {
  ix: Index; personId: string | null; onClose: () => void; initial?: Mode;
}) {
  const run = useRun();
  const [personId, setPersonId] = useState<string | null>(initialPerson);
  const [mode, setMode] = useState<Mode>(initial);
  const [text, setText] = useState(() => (initial === 'in' || !initialPerson ? '' : toText(creditOf(ix, initialPerson))));
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [cover, setCover] = useState(true);
  const [newName, setNewName] = useState('');

  const p = personId ? ix.person.get(personId) : undefined;
  const credit = personId ? creditOf(ix, personId) : 0;
  const book = personId ? heldLedger(ix, personId) : [];
  const owed = personId ? outstanding(ix).find((o) => o.personId === personId)?.amount ?? 0 : 0;
  const amount = parseAmount(text);
  const bad = !personId || amount <= 0 || (mode !== 'in' && amount > credit);

  const pickMode = (m: Mode) => {
    setMode(m);
    setText(m === 'in' ? '' : toText(credit));
  };
  const addNew = async () => {
    const id = await run(() => addPerson(db, newName));
    if (id) { setPersonId(id); setNewName(''); }
  };

  const submit = async () => {
    if (bad || !personId) return;
    const name = p?.name ?? '';
    const ok = mode === 'in'
      ? await run(() => depositCredit(db, { personId, date, amount, note: note.trim() || undefined, coverDebts: cover && owed > 0 }), `Đã ghi ${name} gửi giữ ${money(amount)}`)
      : mode === 'return'
        ? await run(() => returnCredit(db, personId, amount, date, note.trim() || undefined), `Đã ghi trả lại ${name} ${money(amount)}`)
        : await run(() => giftFromCredit(db, personId, amount), `Đã ghi ${name} cho luôn ${money(amount)}`);
    if (ok) {
      if (mode === 'in') { setMode('book'); setText(''); setNote(''); } else onClose();
    }
  };

  // Bước chọn người (khi mở từ nút "+ Nhận tiền giữ" chung).
  if (!personId) {
    return (
      <Modal title="Nhận tiền giữ hộ" onClose={onClose}>
        <span className="small muted">Ai gửi tiền nhờ bạn giữ (để sau này chi hộ)?</span>
        <div className="chips" role="group" aria-label="Chọn người gửi giữ">
          {ix.people.filter((x) => !x.archived).map((x) => (
            <button type="button" key={x.id} className="chip" onClick={() => setPersonId(x.id)}>
              <Avatar person={x} size={22} />{x.name}{creditOf(ix, x.id) > 0 ? ` · giữ ${short(creditOf(ix, x.id))}` : ''}
            </button>
          ))}
        </div>
        <div className="row nowrap" style={{ gap: 8 }}>
          <label className="sr-only" htmlFor="held-new">Thêm người mới</label>
          <input id="held-new" className="input" placeholder="+ Thêm người, ví dụ: Linh" value={newName} onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addNew(); } }} />
          <button type="button" className="btn" onClick={addNew} disabled={!newName.trim()}>Thêm</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Tiền giữ hộ ${p?.name ?? ''}`} onClose={onClose}>
      <div className="summary ok">
        <div className="row"><span>Đang giữ của {p?.name}</span><span className="num">{money(credit)}</span></div>
        {owed > 0 && <div className="row small"><span>{p?.name} đang nợ (chi hộ vượt / đòi lại)</span><span className="num c-owe">{money(owed)}</span></div>}
        <span className="small muted">Tiền giữ nằm trong Số dư tài khoản nhưng không tính vào Số dư của tôi.</span>
      </div>
      <Segmented label="Việc cần làm" value={mode} onChange={pickMode}
        options={[['book', 'Sổ giữ hộ'], ['in', '+ Nhận thêm'], ['return', 'Trả lại'], ['gift', 'Cho luôn']]} />

      {mode === 'book' && (
        <div className="stack" style={{ gap: 8 }}>
          {book.length === 0 ? <Empty>Chưa có lần gửi giữ nào. Bấm “+ Nhận thêm” khi {p?.name} chuyển tiền nhờ giữ.</Empty> : (
            <div className="list">
              {book.map((e, i) => (
                <div className="item" key={i} style={{ minHeight: 48 }}>
                  <span className="xs muted" style={{ width: 76 }}>{fmtDate(e.date)}</span>
                  <span className="grow small">{e.label}</span>
                  <span className={`num small ${e.delta > 0 ? 'c-income' : ''}`}>{e.delta > 0 ? '+' : '−'}{money(Math.abs(e.delta))}</span>
                  <span className="num small muted" style={{ width: 100, textAlign: 'right' }}>{money(e.balance)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => pickMode('in')}>+ Nhận thêm</button>
            <Link to={`/them?loai=ho&p=${personId}`} className="btn primary" onClick={onClose}>Chi hộ {p?.name}</Link>
          </div>
        </div>
      )}

      {mode !== 'book' && (
        <div className="stack" style={{ gap: 12 }}>
          <span className="small muted">
            {mode === 'in'
              ? `${p?.name} chuyển tiền cho bạn giữ để chi hộ. Tài khoản tăng, tiền đang giữ tăng; không phải thu nhập.`
              : mode === 'return'
                ? `Bạn chuyển lại cho ${p?.name}. Tài khoản giảm, tiền đang giữ giảm; không tính là Cho đi.`
                : `${p?.name} không lấy lại phần này. Ghi thành thu nhập “Được cho/tặng”; tiền vào giữ nguyên, Số dư của tôi tăng.`}
          </span>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field grow">
              <label htmlFor="held-amt">{mode === 'in' ? `Số tiền ${p?.name} gửi` : 'Số tiền'}</label>
              <input id="held-amt" className="input" inputMode="decimal" autoFocus placeholder={mode === 'in' ? '20tr' : ''} value={text}
                onChange={(e) => setText(e.target.value)} onBlur={() => amount > 0 && setText(toText(amount))} />
            </div>
            {mode !== 'gift' && (
              <div className="field" style={{ width: 170 }}>
                <label htmlFor="held-date">Ngày</label>
                <input id="held-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            )}
          </div>
          {mode !== 'gift' && (
            <div className="field"><label htmlFor="held-note">Ghi chú</label>
              <input id="held-note" className="input" placeholder={mode === 'in' ? 'Gửi trước để trả hóa đơn' : 'Trả nốt tiền giữ'} value={note} onChange={(e) => setNote(e.target.value)} /></div>
          )}
          {mode === 'in' && owed > 0 && (
            <div className="setting" style={{ borderTop: 0, padding: 0 }}>
              <div className="grow stack tight">
                <span className="strong small">Trừ luôn {money(owed)} {p?.name} đang nợ</span>
                <span className="xs muted">Ví dụ lần chi hộ trước vượt số tiền đang giữ.</span>
              </div>
              <Switch label="Trừ luôn khoản đang nợ" checked={cover} onChange={setCover} />
            </div>
          )}
          {mode === 'in' && amount > 0 && (
            <span className="small">Sau khi lưu: đang giữ của {p?.name} <b>{money(Math.max(0, credit + amount - (cover ? owed : 0)))}</b></span>
          )}
          {mode !== 'in' && amount > credit && <span className="small c-give">Chỉ đang giữ {money(credit)}.</span>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onClose}>Hủy</button>
            <button type="button" className="btn primary" disabled={bad} onClick={submit}>
              {mode === 'in' ? 'Ghi nhận tiền giữ' : mode === 'return' ? 'Ghi trả lại' : 'Ghi cho luôn'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
