import { lazy, Suspense, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Income, Settlement, Transaction } from '../db/schema';
import { fmtDate, inRange, monthLabel, periodOf, periodRange, shiftMonth, today, weekday } from '../domain/period';
import { categoryPath, fold, repayTxs, rootOf, txMatches, type RepayTx } from '../domain/stats';
import { useIndex } from '../ui/data';
import EditTx from '../ui/EditTx';
// Excel export (with the zip library) is only loaded when the dialog opens, to keep the main bundle small.
const ExportDialog = lazy(() => import('../ui/ExportDialog'));
import { Empty, Icon, Modal } from '../ui/kit';
import { money, short, useMask } from '../ui/format';
import { IncomeRow, RepayRow, SettlementRow, TxRow } from '../ui/tx';
import IncomeForm from '../ui/IncomeForm';

type Kind = 'all' | 'expense' | 'transfer' | 'income' | 'in' | 'repay';
type Row = { date: string; created: string; tx?: Transaction; st?: Settlement; inc?: Income; rp?: RepayTx };

export default function Transactions() {
  const ix = useIndex();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [month, setMonth] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [kind, setKind] = useState<Kind>('all');
  const [cat, setCat] = useState('all');
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [exporting, setExporting] = useState(false);
  const [editInc, setEditInc] = useState<Income | null>(null);
  const mask = useMask();
  if (!ix) return <p className="muted">Đang tải…</p>;

  const cur = month ?? periodOf(today(), ix.startDay);
  const range = periodRange(cur, ix.startDay);
  const scope = (d: string) => all || inRange(d, range);

  const catRoots = kind === 'income' ? ix.incomeRoots : ix.roots;
  const catOk = (categoryId: string) => cat === 'all' || rootOf(ix, categoryId)?.id === cat;
  const txs = kind === 'in' || kind === 'income' || kind === 'repay' ? [] : ix.txs.filter((t) => scope(t.date) && (kind === 'all' || t.kind === kind)
    && catOk(t.categoryId) && txMatches(ix, t, q));
  const incs = kind === 'all' || kind === 'income'
    ? ix.incomes.filter((r) => scope(r.date) && catOk(r.categoryId)
      && (!q || fold(`${r.title} ${categoryPath(ix, r.categoryId)} ${r.personId ? ix.person.get(r.personId)?.name ?? '' : ''} thu nhap`).includes(fold(q))))
    : [];
  const sts = (kind === 'all' || kind === 'in') && cat === 'all'
    ? ix.settlements.filter((s) => !s.opening && scope(s.date) && (!q || fold(`${ix.person.get(s.personId)?.name ?? ''} ${s.note ?? ''}`).includes(fold(q))))
    : [];

  // Repayments with money (hold / transfer) are money-out transactions.
  const rps = (kind === 'all' || kind === 'repay') && cat === 'all'
    ? repayTxs(ix).filter((r) => scope(r.date) && (!q || fold(`tra no ${ix.person.get(r.personId)?.name ?? ''} ${r.note ?? ''}`).includes(fold(q))))
    : [];

  const rows: Row[] = [
    ...rps.map((r) => ({ date: r.date, created: r.createdAt, rp: r })),
    ...txs.map((t) => ({ date: t.date, created: t.createdAt, tx: t })),
    ...sts.map((s) => ({ date: s.date, created: s.createdAt, st: s })),
    // A gifted surplus tied to a payment shows inside that payment's row, unless filtering Income only.
    ...incs.filter((r) => kind === 'income' || !r.settlementId).map((r) => ({ date: r.date, created: r.createdAt, inc: r })),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created));
  const days = new Map<string, Row[]>();
  for (const r of rows) days.set(r.date, [...(days.get(r.date) ?? []), r]);

  const out = txs.reduce((a, t) => a + t.totalAmount, 0);
  const inSum = sts.filter((s) => s.direction !== 'out').reduce((a, s) => a + s.amount, 0);
  const outSum = sts.filter((s) => s.direction === 'out').reduce((a, s) => a + s.amount, 0);
  const incSum = incs.reduce((a, r) => a + r.amount, 0);
  const repaySum = rps.reduce((a, r) => a + r.amount, 0);
  // RULE-14: my real spending = Mine + Given; advances = Owed not yet covered by held money.
  let spent = 0, advanced = 0;
  for (const t of txs) {
    for (const sh of ix.sharesOfTx.get(t.id) ?? []) {
      if (sh.type === 'owe') advanced += Math.max(0, sh.amount - (ix.heldCover.get(sh.id) ?? 0) - (ix.offsetCover.get(sh.id) ?? 0) - (ix.forgivenByShare.get(sh.id) ?? 0));
      else spent += sh.amount;
    }
  }
  // Repaying opening debts counts in "Left over" (same as Overview / Stats); in-app debts do not.
  // Includes offsets inside the on-behalf / split transactions shown (offset = repayment).
  const isOld = (payableId?: string) => ix.payableById.get(payableId ?? '')?.origin === 'opening';
  const shown = new Set(txs.flatMap((t) => (ix.sharesOfTx.get(t.id) ?? []).map((sh) => sh.id)));
  const repaidOld = rps.flatMap((r) => r.ids).reduce((a, id) => {
    const rp = ix.repayments.find((x) => x.id === id);
    return a + (rp && isOld(rp.payableId) ? rp.amount : 0);
  }, 0) + ix.offsets.filter((o) => shown.has(o.shareId) && isOld(o.payableId)).reduce((a, o) => a + o.amount, 0);
  const net = incSum - spent - repaidOld;

  const KINDS: [Kind, string][] = [['all', 'Tất cả'], ['expense', 'Chi tiêu'], ['transfer', 'Chuyển tiền'], ['income', 'Thu nhập'], ['in', 'Được trả lại & giữ hộ'],
    ...(ix.repayments.length ? [['repay', 'Trả nợ']] as [Kind, string][] : [])];
  const pickKind = (k: Kind) => { setKind(k); setCat('all'); };

  return (
    <>
      <div className="page-head">
        <div className="stack tight">
          <span className="eyebrow">{all ? 'Tất cả thời gian' : monthLabel(cur)} · {rows.length} giao dịch</span>
          <h1>Giao dịch</h1>
        </div>
        <div className="row">
          <div className="period">
            <button type="button" className="icon-btn" aria-label="Tháng trước" disabled={all} onClick={() => setMonth(shiftMonth(cur, -1))}><Icon name="left" /></button>
            <span>{all ? 'Tất cả' : monthLabel(cur)}</span>
            <button type="button" className="icon-btn" aria-label="Tháng sau" disabled={all} onClick={() => setMonth(shiftMonth(cur, 1))}><Icon name="right" /></button>
          </div>
          <button type="button" className="chip" aria-pressed={all} onClick={() => setAll(!all)}>Mọi tháng</button>
          <button type="button" className="btn" onClick={() => setExporting(true)}>Xuất Excel</button>
          <Link to="/them" className="btn primary hide-sm"><Icon name="plus" size={18} stroke={2.5} />Thêm chi tiêu</Link>
        </div>
      </div>

      <section className="card stack">
        <div className="row">
          <label className="search">
            <Icon name="search" size={18} />
            <span className="sr-only">Tìm giao dịch</span>
            <input className="input" value={q} placeholder="Tìm theo tên, tag, người, danh mục…"
              onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })} />
          </label>
          <div className="chips" role="group" aria-label="Loại">
            {KINDS.map(([k, l]) => <button type="button" key={k} className="chip" aria-pressed={kind === k} onClick={() => pickKind(k)}>{l}</button>)}
          </div>
        </div>
        {kind !== 'in' && kind !== 'repay' && <div className="chips" role="group" aria-label="Danh mục">
          <button type="button" className="chip sm" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>Mọi danh mục</button>
          {catRoots.map((c) => (
            <button type="button" key={c.id} className="chip sm" aria-pressed={cat === c.id} onClick={() => setCat(c.id)}><Icon name={c.icon} size={14} />{c.name}</button>
          ))}
        </div>}
      </section>

      <div className="grid-kpi">
        <div className="card stack tight"><span className="kpi-label">Thu nhập</span><span className="kpi-value c-income">{mask(`+${money(incSum)}`)}</span></div>
        <div className="card stack tight"><span className="kpi-label">Chi tiêu của tôi</span><span className="kpi-value">{spent ? '−' : ''}{money(spent)}</span><span className="kpi-sub">Của tôi + Cho đi</span></div>
        <div className="card stack tight"><span className="kpi-label">Ứng trước (sẽ thu lại)</span><span className="kpi-value c-owe">{money(advanced)}</span>
          <span className="kpi-sub">tiền ra tài khoản −{short(out)} · nhận vào (trả lại, gửi giữ) +{short(inSum)}{outSum > 0 ? ` · trả lại tiền giữ −${short(outSum)}` : ''}{repaySum > 0 ? ` · trả nợ −${mask(short(repaySum))}` : ''}</span></div>
        <div className="card stack tight"><span className="kpi-label">Còn lại (thu nhập − chi tiêu{repaidOld ? ' − trả nợ cũ' : ''})</span><span className={`kpi-value ${net < 0 ? 'c-give' : ''}`}>{incSum || repaidOld ? mask(`${net < 0 ? '−' : '+'}${money(Math.abs(net))}`) : `${net < 0 ? '−' : '+'}${money(Math.abs(net))}`}</span></div>
      </div>

      <section className="card" aria-label="Danh sách giao dịch">
        {rows.length === 0 && <Empty>Không có giao dịch nào khớp bộ lọc.</Empty>}
        {[...days.entries()].map(([d, list]) => {
          const dayNet = list.reduce((a, r) => a - (r.tx?.totalAmount ?? 0) + (r.st ? (r.st.direction === 'out' ? -r.st.amount : r.st.amount + (ix.giftsOfSettlement.get(r.st.id) ?? []).reduce((x, g) => x + g.amount, 0)) : 0) + (r.inc?.amount ?? 0) - (r.rp?.amount ?? 0), 0);
          return (
            <div key={d}>
              <div className="daygroup-head"><span>{weekday(d)}, {fmtDate(d)}</span><span>{dayNet ? (list.some((r) => r.inc || r.rp || (r.st && ix.giftsOfSettlement.has(r.st.id))) ? mask : (x: string) => x)(`${dayNet < 0 ? '−' : '+'}${money(Math.abs(dayNet))}`) : ''}</span></div>
              <div className="list">
                {list.map((r) => r.rp
                  ? <RepayRow key={r.rp.key} ix={ix} rp={r.rp} />
                  : r.tx
                  ? <TxRow key={r.tx.id} ix={ix} tx={r.tx} onEdit={setEditing} />
                  : r.inc
                    ? <IncomeRow key={r.inc.id} ix={ix} income={r.inc} onEdit={setEditInc} />
                    : <SettlementRow key={r.st!.id} ix={ix} st={r.st!} />)}
              </div>
            </div>
          );
        })}
      </section>
      {exporting && <Suspense fallback={null}><ExportDialog ix={ix} onClose={() => setExporting(false)} /></Suspense>}
      {editInc && (
        <Modal title="Sửa thu nhập" onClose={() => setEditInc(null)}>
          <IncomeForm ix={ix} src={editInc} edit onDone={() => setEditInc(null)} />
        </Modal>
      )}
      {editing && <EditTx ix={ix} tx={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
