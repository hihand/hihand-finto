import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { db } from '../db/schema';
import { applyCreditTo, settle } from '../domain/ledger';
import { fmtDayMonth, today } from '../domain/period';
import { parseAmount } from '../domain/split';
import { categoryPath, creditOf, openDebts, outstanding } from '../domain/stats';
import { useIndex } from '../ui/data';
import { Avatar, Empty, Icon, Segmented } from '../ui/kit';
import HeldModal from '../ui/HeldModal';
import { money, short, useRun, noteText, txTitle } from '../ui/format';

const toText = (n: number) => (n ? n.toLocaleString('vi-VN') : '');

/** BR-06/07/08, UC-09, UC-10: thu tiền, trừ một phần, tiền gửi/ứng trước; phần dư cho luôn; phần thiếu bỏ qua. */
export default function Settle() {
  const ix = useIndex();
  const nav = useNavigate();
  const run = useRun();
  const [params, setParams] = useSearchParams();
  const [amountText, setAmountText] = useState('');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [surplus, setSurplus] = useState<'keep' | 'gift'>('keep');
  const [shortfall, setShortfall] = useState<'owe' | 'forgive'>('owe');
  const [held, setHeld] = useState<null | 'book' | 'in' | 'return' | 'gift'>(null);
  if (!ix) return <p className="muted">Đang tải…</p>;

  const owes = outstanding(ix);
  const oweOf = new Map(owes.map((o) => [o.personId, o]));
  // Người đã ẩn nhưng còn nợ / còn tiền giữ vẫn phải thu được.
  const people = [...ix.people.filter((p) => !p.archived || oweOf.has(p.id) || creditOf(ix, p.id) > 0)].sort((a, b) =>
    (oweOf.get(b.id)?.amount ?? 0) - (oweOf.get(a.id)?.amount ?? 0) || creditOf(ix, b.id) - creditOf(ix, a.id));
  const sel = params.get('p') && ix.person.get(params.get('p')!) ? params.get('p')! : people[0]?.id;

  if (!sel) return (
    <>
      <h1>Thu tiền</h1>
      <Empty>Chưa có ai trong danh bạ. <Link to="/cai-dat">Thêm người</Link> hoặc thêm khi nhập chi tiêu.</Empty>
    </>
  );

  const P = ix.person.get(sel)!;
  const debts = openDebts(ix, sel);
  const credit = creditOf(ix, sel);
  const received = parseAmount(amountText);
  const available = received + credit;
  const picked = debts.filter((d) => picks[d.share.id] !== undefined).map((d) => ({ d, amount: parseAmount(picks[d.share.id]) }));
  const pickedSum = picked.reduce((a, p) => a + p.amount, 0);
  const badPick = picked.find((p) => p.amount <= 0 || p.amount > p.d.remaining);
  const diff = available - pickedSum;
  const owedNow = oweOf.get(sel)?.amount ?? 0;

  const choose = (id: string) => {
    setParams({ p: id }, { replace: true });
    setPicks({});
    setAmountText('');
    setNote('');
    setSurplus('keep');
    setShortfall('owe');
  };
  const autoPick = () => {
    let left = available;
    const next: Record<string, string> = {};
    for (const d of debts) {
      if (left <= 0) break;
      const take = Math.min(left, d.remaining);
      next[d.share.id] = toText(take);
      left -= take;
    }
    setPicks(next);
  };
  const toggle = (id: string, remaining: number) => setPicks((p) => {
    const n = { ...p };
    if (n[id] !== undefined) delete n[id];
    else n[id] = toText(remaining);
    return n;
  });

  const creditOnly = received === 0 && picked.length > 0;
  const tip = Math.max(0, received - pickedSum); // phần dư của tiền vừa nhận (UC-09)
  const gift = surplus === 'gift' ? tip : 0;
  const forgiveAmt = diff < 0 && shortfall === 'forgive' ? -diff : 0;
  const canSave = (received > 0 || (creditOnly && diff >= 0)) && !badPick && !saving;
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const ok = creditOnly
      ? await run(() => applyCreditTo(db, sel, picked.map((p) => ({ shareId: p.d.share.id, amount: p.amount }))), `Đã trừ ${money(pickedSum)} vào tiền đang giữ của ${P.name}`)
      : await run(() => settle(db, {
      personId: sel, date, amount: received, note: note.trim() || undefined,
      picks: picked.map((p) => ({ shareId: p.d.share.id, amount: p.amount })),
      surplus: tip > 0 ? surplus : 'keep', shortfall: diff < 0 ? shortfall : undefined,
    }), picked.length ? `Đã thu ${money(received)} của ${P.name}` : gift ? `Đã ghi ${P.name} cho ${money(received)}` : `Đã ghi ${P.name} gửi giữ ${money(received)}`);
    setSaving(false);
    if (ok) nav('/moi-nguoi');
  };

  return (
    <>
      <div className="stack tight">
        <Link to="/moi-nguoi" className="back">‹ Mọi người</Link>
        <h1>Thu tiền</h1>
      </div>
      <div className="cols">
        <section className="card stack col-side" style={{ padding: 16 }} aria-label="Chọn người">
          <span className="label" style={{ padding: '4px 8px' }}>Đang đòi lại · {money(owes.reduce((a, o) => a + o.amount, 0))}</span>
          <div className="stack" style={{ gap: 4 }}>
            {people.map((p) => {
              const o = oweOf.get(p.id);
              const c = creditOf(ix, p.id);
              return (
                <button type="button" key={p.id} className="pick" aria-pressed={p.id === sel} onClick={() => choose(p.id)}>
                  <Avatar person={p} />
                  <span className="grow stack tight">
                    <span className="title">{p.name}</span>
                    <span className="meta">{o ? `${o.count} khoản · cũ nhất ${fmtDayMonth(o.oldest)}` : 'không nợ'}{c > 0 ? ` · đang giữ ${short(c)}` : ''}</span>
                  </span>
                  <span className="num c-owe">{o ? money(o.amount) : ''}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="card stack col-main" aria-label={`Thu tiền của ${P.name}`}>
          <div className="row" style={{ alignItems: 'flex-end', gap: 16 }}>
            <div className="field" style={{ flex: '2 1 240px' }}>
              <label htmlFor="recv">{P.name} vừa chuyển cho bạn</label>
              <input id="recv" className="input big c-income" inputMode="decimal" autoComplete="off" placeholder="200k" value={amountText}
                onChange={(e) => setAmountText(e.target.value)} onBlur={() => received > 0 && setAmountText(toText(received))} />
            </div>
            <div className="field" style={{ flex: '1 1 150px' }}>
              <label htmlFor="rdate">Ngày</label>
              <input id="rdate" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <button type="button" className="btn" style={{ background: 'var(--mine-bg)', color: 'var(--mine-text)' }} onClick={autoPick} disabled={available <= 0 || debts.length === 0}>
              Tự chọn khoản cũ nhất
            </button>
          </div>
          {credit > 0 && (
            <div className="row small" style={{ gap: 8 }}>
              <span className="grow"><span className="c-income strong">Đang giữ của {P.name} {money(credit)}</span> <span className="muted">— được cộng khi trừ khoản; để trống số tiền nhận nếu chỉ muốn trừ vào tiền đang giữ.</span></span>
              <Link to={`/them?loai=ho&p=${sel}`} className="btn sm">Chi hộ</Link>
              <button type="button" className="btn sm" onClick={() => setHeld('return')}>Trả lại</button>
              <button type="button" className="btn sm" onClick={() => setHeld('book')}>Sổ giữ hộ</button>
            </div>
          )}
          {noteText(ix, sel) && <div className="note">{noteText(ix, sel)}</div>}

          <div className="stack tight">
            <span className="label">Trừ vào khoản nào? (cũ nhất trước) · không chọn = gửi giữ / ứng trước</span>
            {debts.length === 0 && <Empty>{P.name} không còn khoản Đòi lại nào. Tiền nhận sẽ thành tiền đang giữ.</Empty>}
            <div className="list">
              {debts.map((d) => {
                const on = picks[d.share.id] !== undefined;
                const v = parseAmount(picks[d.share.id] ?? '');
                const partial = on && v > 0 && v < d.remaining;
                return (
                  <div className="item" key={d.share.id}>
                    <button type="button" className="pick" style={{ flex: 1, padding: '4px 0', background: 'transparent' }} aria-pressed={on} onClick={() => toggle(d.share.id, d.remaining)}>
                      <span className={`check ${on ? 'on' : ''}`}>{on && <Icon name="check" size={14} stroke={3.5} />}</span>
                      <span className="xs muted" style={{ width: 40 }}>{fmtDayMonth(d.tx.date)}</span>
                      <span className="grow stack tight">
                        <span className="title">{txTitle(ix, d.tx)}</span>
                        <span className="meta">{categoryPath(ix, d.tx.categoryId)}{d.paid > 0 ? ` · đã trả ${short(d.paid)}/${short(d.share.amount)}` : ''}{partial ? ` · trừ một phần, còn ${short(d.remaining - v)}` : ''}</span>
                      </span>
                    </button>
                    {on
                      ? <input aria-label={`Số trừ cho ${txTitle(ix, d.tx)}`} className="input amount" inputMode="decimal" value={picks[d.share.id]}
                        onChange={(e) => setPicks((p) => ({ ...p, [d.share.id]: e.target.value }))} />
                      : <span className="num">{money(d.remaining)}</span>}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="field"><label htmlFor="rnote">Ghi chú</label><input id="rnote" className="input" placeholder="Chuyển khoản" value={note} onChange={(e) => setNote(e.target.value)} /></div>

          {tip > 0 && received > 0 && (
            <div className="field">
              <span className="label" id="surplus-l">Phần dư {money(tip)} của lần này</span>
              <Segmented label={`Phần dư ${money(tip)}`} value={surplus} onChange={setSurplus}
                options={[['keep', `Giữ lại cho ${P.name}`], ['gift', `${P.name} cho luôn`]]} />
            </div>
          )}
          {diff < 0 && received > 0 && !badPick && (
            <div className="field">
              <span className="label">Còn thiếu {money(-diff)} so với khoản đã chọn</span>
              <Segmented label={`Còn thiếu ${money(-diff)}`} value={shortfall} onChange={setShortfall}
                options={[['owe', `Để ${P.name} nợ tiếp`], ['forgive', `Cho ${P.name} luôn`]]} />
            </div>
          )}

          <div className={`summary ${diff >= 0 || shortfall === 'forgive' ? 'ok' : 'warn'}`} aria-live="polite">
            <div className="row"><span>Nhận</span><span className="num">{money(received)}</span></div>
            {credit > 0 && <div className="row"><span>Đang giữ từ trước</span><span className="num">+{money(credit)}</span></div>}
            <div className="row"><span>Trừ {picked.length} khoản đã chọn</span><span className="num">−{money(Math.min(pickedSum, available))}</span></div>
            {forgiveAmt > 0 && <div className="row"><span>Bạn cho {P.name} (bỏ qua)</span><span className="num c-give">{money(forgiveAmt)}</span></div>}
            {gift > 0 && <div className="row"><span>{P.name} cho luôn (thu nhập)</span><span className="num c-income">{money(gift)}</span></div>}
            <div className="row total">
              <span>{diff >= 0 ? `Đang giữ của ${P.name} sau khi lưu` : shortfall === 'forgive' ? 'Còn thiếu' : `${P.name} còn nợ thêm`}</span>
              <span className="num">{money(diff >= 0 ? diff - gift : shortfall === 'forgive' ? 0 : -diff)}</span>
            </div>
            <span className="small muted">
              {badPick ? 'Số trừ phải lớn hơn 0 và không vượt số còn thiếu của khoản.'
                : `Sau khi lưu: còn đòi lại ${P.name} ${money(owedNow - Math.min(pickedSum, available) - forgiveAmt)} · tiền vào tài khoản ${money(received)}.`}
            </span>
          </div>
          <button type="button" className="btn primary" style={{ height: 52 }} disabled={!canSave} onClick={save}>
            {creditOnly ? 'Trừ vào tiền đang giữ' : 'Xác nhận thu tiền'}
          </button>
        </section>
      </div>
      {held && <HeldModal ix={ix} personId={sel} initial={held} onClose={() => setHeld(null)} />}
    </>
  );
}
