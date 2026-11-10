import { db } from '../db/schema';
import { forgiveShare } from '../domain/ledger';
import { today } from '../domain/period';
import { parseAmount } from '../domain/split';
import HeldModal from '../ui/HeldModal';
import DebtModal from '../ui/DebtModal';
import { Modal } from '../ui/kit';
import { useMask, useRun } from '../ui/format';
import type { Income } from '../db/schema';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { monthLabel, weekday } from '../domain/period';
import { creditOf, debtSummary, owedTo, peopleSummary, rootOf, categoryPath, giftsFromPeople, type Index } from '../domain/stats';
import { useIndex } from '../ui/data';
import { Avatar, Empty, Pill } from '../ui/kit';
import { STATUS_LABEL, money, short, noteText } from '../ui/format';
import { txTitle } from '../ui/format';

type Tab = 'give' | 'owe';

/** BR-13, BR-08, UC-08: Cho đi / Đòi lại từ trước tới nay, theo người, theo tháng, lọc danh mục. */
export default function People() {
  const ix = useIndex();
  const [view, setView] = useState<Tab | 'gift'>('give');
  const tab: Tab = view === 'owe' ? 'owe' : 'give';
  const [sel, setSel] = useState<Record<Tab, string | null>>({ give: null, owe: null });
  const [filter, setFilter] = useState('all');
  const [held, setHeld] = useState<{ id: string | null; mode?: 'book' | 'in' } | null>(null);
  const [forgive, setForgive] = useState<{ shareId: string; remaining: number; title: string } | null>(null);
  const [debt, setDebt] = useState<{ id: string | null } | null>(null);
  const mask = useMask();
  if (!ix) return <p className="muted">Đang tải…</p>;

  const give = peopleSummary(ix, 'give');
  const owe = peopleSummary(ix, 'owe');
  const list = tab === 'give' ? give : owe;
  const giveTotal = give.reduce((a, p) => a + p.total, 0);
  const oweTotal = owe.reduce((a, p) => a + p.total, 0);
  const waiting = owe.reduce((a, p) => a + p.waiting, 0);
  const holding = ix.people.map((p) => ({ p, credit: creditOf(ix, p.id) })).filter((x) => x.credit > 0);

  const selId = list.some((p) => p.personId === sel[tab]) ? sel[tab]! : list[0]?.personId;
  const S = list.find((p) => p.personId === selId);
  const person = selId ? ix.person.get(selId) : undefined;
  const pick = (t: Tab | 'gift') => { setView(t); setFilter('all'); };
  const gifts = giftsFromPeople(ix);
  const giftTotal = gifts.reduce((a, g) => a + g.total, 0);

  const byCat = new Map<string, { name: string; amount: number }>();
  for (const e of S?.entries ?? []) {
    const r = rootOf(ix, e.tx.categoryId);
    const k = r?.id ?? '?';
    byCat.set(k, { name: e.tx.opening ? 'Số đầu kỳ' : r?.name ?? '?', amount: (byCat.get(k)?.amount ?? 0) + e.amount });
  }
  const filt = byCat.has(filter) ? filter : 'all';
  const shown = (S?.entries ?? []).filter((e) => filt === 'all' || rootOf(ix, e.tx.categoryId)?.id === filt);
  const months = new Map<string, typeof shown>();
  for (const e of shown) months.set(e.tx.date.slice(0, 7), [...(months.get(e.tx.date.slice(0, 7)) ?? []), e]);
  const credit = selId ? creditOf(ix, selId) : 0;
  const iOwe = selId ? owedTo(ix, selId) : 0;
  // Người còn công nợ trước; người đã huề hết (vẫn có sổ nợ) ở sau.
  const debts = debtSummary(ix);
  for (const id of new Set(ix.payables.map((x) => x.personId))) if (!debts.some((d) => d.personId === id)) debts.push({ personId: id, iOwe: 0, theyOwe: 0 });

  return (
    <>
      <div className="stack tight">
        <h1>Mọi người</h1>
        <span className="muted small">Tiền bạn chi cho người khác · từ trước tới nay</span>
      </div>

      <div className="grid-kpi" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        <button type="button" className="card kpi-btn give stack tight" aria-pressed={view === 'give'} onClick={() => pick('give')}>
          <span className="strong c-give">Cho đi</span>
          <span className="kpi-value">{giveTotal ? '−' : ''}{money(giveTotal)}</span>
          <span className="kpi-sub">{give.length} người · không cần trả lại</span>
        </button>
        <button type="button" className="card kpi-btn owe stack tight" aria-pressed={view === 'owe'} onClick={() => pick('owe')}>
          <span className="strong c-owe">Đòi lại</span>
          <span className="kpi-value">{oweTotal ? '−' : ''}{money(oweTotal)}</span>
          <span className="kpi-sub">đã thu {short(oweTotal - waiting)} · đang chờ {short(waiting)}</span>
        </button>
        <button type="button" className="card kpi-btn gift stack tight" aria-pressed={view === 'gift'} onClick={() => pick('gift')}>
          <span className="strong c-income">Đã cho bạn</span>
          <span className="kpi-value">{mask(`${giftTotal ? '+' : ''}${money(giftTotal)}`)}</span>
          <span className="kpi-sub">{gifts.length} người · thu nhập có gắn người</span>
        </button>
      </div>

      {view === 'gift' ? <Gifts ix={ix} /> : <div className="cols">
        <div className="col-side">
          <section className="card stack" style={{ padding: 16 }}>
            <span className="label" style={{ padding: '4px 8px' }}>{tab === 'give' ? 'Cho đi theo từng người' : 'Đòi lại theo từng người'}</span>
            {list.length === 0 && <Empty>Chưa có khoản {tab === 'give' ? 'cho đi' : 'đòi lại'} nào.</Empty>}
            <div className="stack" style={{ gap: 4 }}>
              {list.map((s) => {
                const p = ix.person.get(s.personId);
                return (
                  <button type="button" key={s.personId} className="pick" aria-pressed={s.personId === selId}
                    onClick={() => { setSel({ ...sel, [tab]: s.personId }); setFilter('all'); }}>
                    <Avatar person={p} />
                    <span className="grow stack tight">
                      <span className="title">{p?.name}</span>
                      <span className="meta">{s.entries.length} khoản{tab === 'owe' ? ` · chờ ${money(s.waiting)}` : ''}</span>
                    </span>
                    <span className="num">−{money(s.total)}</span>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="card stack">
            <div className="row between">
              <h2>Công nợ</h2>
              <button type="button" className="btn sm primary" onClick={() => setDebt({ id: null })}>+ Số đầu kỳ</button>
            </div>
            {debts.length === 0 && <span className="small muted">Khoản bạn đang nợ ai đó (hoặc ai đó nợ bạn) từ trước khi dùng app thì bấm “+ Số đầu kỳ”.</span>}
            {debts.length > 0 && (
              <div className="list">
                {debts.map((d) => {
                  const dp = ix.person.get(d.personId);
                  return (
                    <button type="button" className="item item-btn" key={d.personId} onClick={() => setDebt({ id: d.personId })} aria-label={`Công nợ với ${dp?.name}. Mở sổ nợ`}>
                      <Avatar person={dp} />
                      <span className="grow stack tight">
                        <span className="title">{dp?.name}</span>
                        <span className="meta">Sổ nợ · trả nợ · cấn trừ · xóa nợ</span>
                      </span>
                      <span className="stack tight" style={{ alignItems: 'flex-end' }}>
                        {d.iOwe > 0 && <span className="num small c-give">Tôi nợ {mask(short(d.iOwe))}</span>}
                        {d.theyOwe > 0 && <span className="num small c-owe">Nợ tôi {short(d.theyOwe)}</span>}
                        {!d.iOwe && !d.theyOwe && <span className="small muted">Đã huề</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
          <section className="card stack">
            <div className="row between">
              <h2>Tiền giữ hộ</h2>
              <button type="button" className="btn sm primary" onClick={() => setHeld({ id: null, mode: 'in' })}>+ Nhận tiền giữ</button>
            </div>
            {holding.length === 0 && <span className="small muted">Ai gửi tiền nhờ bạn giữ để chi hộ (bạn bè, bố mẹ, anh chị em…) thì bấm “+ Nhận tiền giữ”.</span>}
            {holding.length > 0 && (
              <div className="list">
                {holding.map(({ p, credit: c }) => (
                  <button type="button" className="item item-btn" key={p.id} onClick={() => setHeld({ id: p.id })} aria-label={`Tiền giữ hộ ${p.name}: ${money(c)}. Mở sổ giữ hộ`}>
                    <Avatar person={p} />
                    <span className="grow stack tight">
                      <span className="title">Đang giữ của {p.name}</span>
                      {noteText(ix, p.id) ? <span className="note">{noteText(ix, p.id)}</span> : <span className="meta">Sổ giữ hộ · chi hộ · trả lại · cho luôn</span>}
                    </span>
                    <span className="num c-income">{money(c)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        <section className="card stack col-main">
          {!S || !person ? <Empty>Chọn một người để xem chi tiết.</Empty> : (
            <>
              <div className="row" style={{ gap: 14 }}>
                <Avatar person={person} size={52} />
                <div className="grow stack tight">
                  <h2 style={{ fontSize: 22 }}>{person.name}</h2>
                  <span className="meta">
                    {tab === 'give' ? `${S.entries.length} khoản cho · không cần trả lại`
                      : `${S.entries.length} khoản · đã trả ${money(S.total - S.waiting)} · đang chờ ${money(S.waiting)}`}
                    {credit > 0 ? ` · đang giữ ${money(credit)}` : ''}
                    {iOwe > 0 ? ` · tôi đang nợ ${mask(money(iOwe))}` : ''}
                  </span>
                  {noteText(ix, person.id) && <span className="note">{noteText(ix, person.id)}</span>}
                </div>
                <span className={`num ${tab === 'give' ? 'c-give' : 'c-owe'}`} style={{ fontSize: 24 }}>−{money(S.total)}</span>
                {credit > 0 && <button type="button" className="btn sm" onClick={() => setHeld({ id: person.id })}>Tiền giữ hộ</button>}
                <button type="button" className="btn sm" onClick={() => setDebt({ id: person.id })}>Công nợ</button>
                {tab === 'owe' && S.waiting > 0 && (
                  <Link to={`/thu-tien?p=${person.id}`} className="btn sm" style={{ background: 'var(--owe-bg)', color: 'var(--owe)' }}>Thu tiền</Link>
                )}
              </div>
              <div className="chips" role="group" aria-label="Lọc theo danh mục">
                <button type="button" className="chip sm" aria-pressed={filt === 'all'} onClick={() => setFilter('all')}>Tất cả −{short(S.total)}</button>
                {[...byCat.entries()].map(([id, c]) => (
                  <button type="button" key={id} className="chip sm" aria-pressed={filt === id} onClick={() => setFilter(id)}>{c.name} −{short(c.amount)}</button>
                ))}
              </div>
              <div>
                {[...months.entries()].map(([m, items]) => (
                  <div key={m}>
                    <div className="daygroup-head"><span>{monthLabel(m)}</span><span>−{money(items.reduce((a, e) => a + e.amount, 0))}</span></div>
                    <div className="list">
                      {items.map((e) => (
                        <div className="item" key={e.share.id + (e.fromForgive ? '-f' : '')}>
                          <span className="datebox"><b>{e.tx.date.slice(8)}</b>{weekday(e.tx.date)}</span>
                          <span className="grow stack tight">
                            <span className="title">{txTitle(ix, e.tx)}{e.tx.onBehalf ? ' · chi hộ' : ''}</span>
                            <span className="meta">
                              {e.fromForgive ? 'Bạn bỏ qua khoản Đòi lại này' : e.tx.opening ? 'Họ nợ từ trước khi dùng app' : `${rootOf(ix, e.tx.categoryId)?.name} · bill ${short(e.tx.totalAmount)}`}
                              {!e.fromForgive && e.status === 'partial' ? ` · đã trả ${short(e.paid)}` : ''}
                              {!e.fromForgive && e.forgiven > 0 ? ` · bỏ qua ${short(e.forgiven)}` : ''}
                              {!e.fromForgive && e.offset ? ` · ${short(e.offset)} là trả nợ (cấn trừ)` : ''}
                            </span>
                          </span>
                          {e.status && <Pill kind={e.status}>{STATUS_LABEL[e.status]}</Pill>}
                          {tab === 'owe' && e.status !== 'paid' && (
                            <button type="button" className="btn sm" onClick={() => setForgive({ shareId: e.share.id, remaining: e.amount - e.paid, title: txTitle(ix, e.tx) })}>Bỏ qua</button>
                          )}
                          <span className="num">−{money(e.amount)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>}
      {held && <HeldModal ix={ix} personId={held.id} initial={held.mode ?? 'book'} onClose={() => setHeld(null)} />}
      {debt && <DebtModal ix={ix} personId={debt.id} initial={debt.id ? 'book' : 'opening'} onClose={() => setDebt(null)} />}
      {forgive && person && <ForgiveDialog name={person.name} {...forgive} onClose={() => setForgive(null)} />}
    </>
  );
}

/** UC-10 (không kèm lần nhận): bỏ qua một phần / cả khoản Đòi lại — phần đó thành Cho đi. */
function ForgiveDialog({ name, shareId, remaining, title, onClose }: { name: string; shareId: string; remaining: number; title: string; onClose: () => void }) {
  const run = useRun();
  const [text, setText] = useState(remaining.toLocaleString('vi-VN'));
  const [date, setDate] = useState(today());
  const amount = parseAmount(text);
  const bad = amount <= 0 || amount > remaining;
  return (
    <Modal title={`Bỏ qua cho ${name}`} onClose={onClose}>
      <span className="small muted">“{title}” còn thiếu {money(remaining)}. Phần bỏ qua thành <b>Cho {name}</b>; không đổi tiền trong tài khoản, không đổi Chi của tôi.</span>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field grow"><label htmlFor="fg-amt">Số tiền bỏ qua</label><input id="fg-amt" className="input" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} /></div>
        <div className="field" style={{ width: 170 }}><label htmlFor="fg-date">Ngày</label><input id="fg-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      </div>
      {amount > remaining && <span className="small c-give">Chỉ còn thiếu {money(remaining)}.</span>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onClose}>Hủy</button>
        <button type="button" className="btn primary" disabled={bad}
          onClick={async () => { if (await run(() => forgiveShare(db, shareId, amount, date), `Đã bỏ qua ${money(amount)} cho ${name}`)) onClose(); }}>Bỏ qua</button>
      </div>
    </Modal>
  );
}

/** Người đã cho bạn tiền (thu nhập có gắn người), từ trước tới nay, nhóm theo tháng. */
function Gifts({ ix }: { ix: Index }) {
  const gifts = giftsFromPeople(ix);
  const [sel, setSel] = useState<string | null>(null);
  const mask = useMask();
  const g = gifts.find((x) => x.personId === sel) ?? gifts[0];
  const p = g ? ix.person.get(g.personId) : undefined;
  const months = new Map<string, Income[]>();
  for (const r of g?.items ?? []) months.set(r.date.slice(0, 7), [...(months.get(r.date.slice(0, 7)) ?? []), r]);
  return (
    <div className="cols">
      <section className="card stack col-side" style={{ padding: 16 }}>
        <span className="label" style={{ padding: '4px 8px' }}>Đã cho bạn theo từng người</span>
        {gifts.length === 0 && <Empty>Chưa có. Khi ghi thu nhập, chọn “Ai cho?” để khoản đó hiện ở đây.</Empty>}
        <div className="stack" style={{ gap: 4 }}>
          {gifts.map((x) => (
            <button type="button" key={x.personId} className="pick" aria-pressed={x.personId === g?.personId} onClick={() => setSel(x.personId)}>
              <Avatar person={ix.person.get(x.personId)} />
              <span className="grow stack tight"><span className="title">{ix.person.get(x.personId)?.name}</span><span className="meta">{x.items.length} khoản</span></span>
              <span className="num c-income">{mask(`+${money(x.total)}`)}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="card stack col-main">
        {!g || !p ? <Empty>Chọn một người để xem chi tiết.</Empty> : (
          <>
            <div className="row" style={{ gap: 14 }}>
              <Avatar person={p} size={52} />
              <div className="grow stack tight"><h2 style={{ fontSize: 22 }}>{p.name}</h2><span className="meta">{g.items.length} khoản đã cho bạn</span></div>
              <span className="num c-income" style={{ fontSize: 24 }}>{mask(`+${money(g.total)}`)}</span>
            </div>
            {[...months.entries()].map(([m, items]) => (
              <div key={m}>
                <div className="daygroup-head"><span>{monthLabel(m)}</span><span>{mask(`+${money(items.reduce((a, r) => a + r.amount, 0))}`)}</span></div>
                <div className="list">
                  {items.map((r) => (
                    <div className="item" key={r.id}>
                      <span className="datebox"><b>{r.date.slice(8)}</b>{weekday(r.date)}</span>
                      <span className="grow stack tight"><span className="title">{r.title || categoryPath(ix, r.categoryId)}</span><span className="meta">{categoryPath(ix, r.categoryId)}</span></span>
                      <span className="num c-income">{mask(`+${money(r.amount)}`)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </section>
    </div>
  );
}
