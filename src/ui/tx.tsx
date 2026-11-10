import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, type Income, type Settlement, type Transaction } from '../db/schema';
import { deleteRepayments, restoreRepayments } from '../domain/debt';
import { deleteIncome, restoreIncome } from '../domain/income';
import { deleteSettlement, deleteTransaction, restoreTransaction } from '../domain/ledger';
import { fmtDate, fmtDayMonth } from '../domain/period';
import { categoryPath, owedTo, rootOf, statusOf, txTotals, type Index, type RepayTx } from '../domain/stats';
import { Avatar, Icon, Pill } from './kit';
import { STATUS_LABEL, money, short, txTitle, useRun, useToast, useMask } from './format';

export function TxPills({ ix, tx }: { ix: Index; tx: Transaction }) {
  const t = txTotals(ix, tx);
  // Phần Đòi lại đã trả bằng tiền đang giữ (chi hộ / tự trừ) không phải ứng trước.
  const covered = (ix.sharesOfTx.get(tx.id) ?? []).filter((x) => x.type === 'owe').reduce((a, x) => a + Math.min(x.amount, ix.heldCover.get(x.id) ?? 0), 0);
  // Phần cấn trừ với khoản tôi nợ người đó (UC-17): là trả nợ, không phải ứng trước.
  const offset = (ix.sharesOfTx.get(tx.id) ?? []).filter((x) => x.type === 'owe').reduce((a, x) => a + (ix.offsetCover.get(x.id) ?? 0), 0);
  return (
    <span className="row" style={{ gap: 4 }}>
      {t.mine > 0 && <Pill kind="mine">Của tôi {short(t.mine)}</Pill>}
      {covered > 0 && <Pill kind="in">Trừ tiền giữ {short(covered)}</Pill>}
      {offset > 0 && <Pill kind="give">Trả nợ {short(offset)}</Pill>}
      {t.owe - covered - offset > 0 && <Pill kind="owe">Đòi lại {short(t.owe - covered - offset)}</Pill>}
      {t.give > 0 && <Pill kind="give">Cho {short(t.give)}</Pill>}
    </span>
  );
}

function txSub(ix: Index, tx: Transaction) {
  const tags = (ix.tagIdsOfTx.get(tx.id) ?? []).map((id) => '#' + (ix.tag.get(id)?.name ?? '')).join(' ');
  const n = ix.sharesOfTx.get(tx.id)?.length ?? 0;
  const parts = [categoryPath(ix, tx.categoryId)];
  if (tx.productName && tx.title) parts.push(tx.productName);
  if (tags) parts.push(tags);
  if (tx.kind === 'transfer') parts.push('chuyển tiền');
  else if (tx.onBehalf) parts.push(`chi hộ ${(ix.sharesOfTx.get(tx.id) ?? []).map((s) => ix.person.get(s.personId ?? '')?.name).filter(Boolean).join(', ')}`);
  else if (n > 1) parts.push(tx.splitMode === 'equal' ? `chia ${n}` : 'tùy chỉnh');
  return parts.join(' · ');
}

export function TxRow({ ix, tx, onEdit, compact }: { ix: Index; tx: Transaction; onEdit?: (tx: Transaction) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const run = useRun();
  const toast = useToast();
  const root = rootOf(ix, tx.categoryId);

  const remove = async () => {
    const stamp = await run(() => deleteTransaction(db, tx.id));
    if (!stamp) return;
    toast({ text: `Đã xóa “${txTitle(ix, tx)}”`, action: { label: 'Hoàn tác', run: () => run(() => restoreTransaction(db, tx.id, stamp)) } }, 10_000);
  };

  return (
    <div>
      <button type="button" className="item item-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        {compact
          ? <span className="xs muted" style={{ width: 44, flexShrink: 0 }}>{fmtDayMonth(tx.date)}</span>
          : <span className="avatar" style={{ width: 40, height: 40, ['--av' as string]: 'var(--primary)' }} aria-hidden="true"><Icon name={root?.icon ?? 'dots'} size={18} /></span>}
        <span className="grow stack tight">
          <span className="title">{txTitle(ix, tx)}</span>
          <span className="meta">{txSub(ix, tx)}</span>
        </span>
        <span className="hide-sm"><TxPills ix={ix} tx={tx} /></span>
        <span className="num">−{money(tx.totalAmount)}</span>
      </button>
      {open && (
        <div className="detail">
          {(ix.sharesOfTx.get(tx.id) ?? []).map((s) => {
            const p = s.personId ? ix.person.get(s.personId) : null;
            const st = s.type === 'owe' ? statusOf(ix, s) : null;
            const paid = ix.paid.get(s.id) ?? 0;
            return (
              <div className="line" key={s.id}>
                <Avatar person={p} size={28} />
                <span className="grow">{p ? p.name : 'Phần của tôi'}</span>
                {/* Cấn trừ hết với khoản tôi nợ người đó → phần này là trả nợ, không phải Đòi lại. */}
                {s.type === 'owe' && (ix.offsetCover.get(s.id) ?? 0) >= s.amount
                  ? <Pill kind="give">Trả nợ (cấn trừ)</Pill>
                  : <Pill kind={s.type}>{s.type === 'mine' ? 'Của tôi' : s.type === 'owe' ? 'Đòi lại' : 'Cho'}</Pill>}
                {st && (ix.offsetCover.get(s.id) ?? 0) < s.amount && <Pill kind={st}>{st === 'partial' ? `Còn ${short(s.amount - paid)}` : STATUS_LABEL[st]}</Pill>}
                {(ix.forgivenByShare.get(s.id) ?? 0) > 0 && <Pill kind="give">Bỏ qua {short(ix.forgivenByShare.get(s.id)!)}</Pill>}
                {(ix.offsetCover.get(s.id) ?? 0) > 0 && (ix.offsetCover.get(s.id) ?? 0) < s.amount && <Pill kind="give">Trả nợ {short(ix.offsetCover.get(s.id)!)}</Pill>}
                <span className="num">{money(s.amount)}</span>
              </div>
            );
          })}
          <div className="xs muted">Ngày {fmtDate(tx.date)}{tx.productName ? ` · ${tx.productName}` : ''}</div>
          <div className="row">
            {onEdit && <button type="button" className="btn sm" onClick={() => onEdit(tx)}>Sửa</button>}
            <button type="button" className="btn sm" onClick={() => nav(`/them?copy=${tx.id}`)}>Nhân bản</button>
            <button type="button" className="btn sm danger" onClick={remove}>Xóa</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Một lần nhận tiền (kèm phần cho luôn / bỏ qua) hoặc một lần trả lại tiền giữ (UC-13). */
export function SettlementRow({ ix, st }: { ix: Index; st: Settlement }) {
  const [open, setOpen] = useState(false);
  const run = useRun();
  const p = ix.person.get(st.personId);
  const out = st.direction === 'out';
  const allocs = ix.allocsOfSettlement.get(st.id) ?? [];
  const used = allocs.filter((a) => a.kind !== 'forgive').reduce((a, x) => a + x.amount, 0);
  const forgiven = allocs.filter((a) => a.kind === 'forgive').reduce((a, x) => a + x.amount, 0);
  const gift = (ix.giftsOfSettlement.get(st.id) ?? []).reduce((a, r) => a + r.amount, 0);
  const total = st.amount + gift;
  const remove = () => {
    const msg = out
      ? `Xóa lần trả lại ${money(st.amount)} cho ${p?.name}? Tiền đang giữ của ${p?.name} tăng lại.`
      : `Xóa lần nhận ${money(total)} của ${p?.name}? Các khoản đã trừ (và phần cho luôn / bỏ qua) sẽ được gỡ.`;
    if (confirm(msg)) run(() => deleteSettlement(db, st.id), out ? 'Đã xóa lần trả lại' : 'Đã xóa lần nhận tiền');
  };
  const meta = out ? `trả lại tiền đang giữ${st.note ? ' · ' + st.note : ''}`
    : [st.note, used ? `trả ${short(used)}` : '', gift ? `cho luôn ${short(gift)}` : '', forgiven ? `bạn bỏ qua ${short(forgiven)}` : '',
      st.amount > used ? `giữ ${short(st.amount - used)}` : ''].filter(Boolean).join(' · ') || 'gửi giữ / ứng trước';
  return (
    <div>
      <button type="button" className="item item-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`avatar ${out ? '' : 'c-income'}`} style={{ width: 40, height: 40, ['--av' as string]: out ? 'var(--owe)' : 'var(--income)' }} aria-hidden="true"><Icon name={out ? 'outgo' : 'income'} size={18} /></span>
        <span className="grow stack tight">
          <span className="title">{out ? `Trả lại ${p?.name ?? '?'}` : `${p?.name ?? '?'} chuyển cho bạn`}</span>
          <span className="meta">{meta}</span>
        </span>
        <span className="hide-sm row" style={{ gap: 4 }}>
          {used > 0 && <Pill kind="paid">Trừ {short(used)}</Pill>}
          {gift > 0 && <Pill kind="in">Cho {short(gift)}</Pill>}
          {forgiven > 0 && <Pill kind="give">Bỏ qua {short(forgiven)}</Pill>}
        </span>
        <span className={`num ${out ? '' : 'c-income'}`}>{out ? '−' : '+'}{money(total)}</span>
      </button>
      {open && (
        <div className="detail">
          {!out && allocs.length === 0 && !gift && <div className="small muted">Không trừ khoản nào — toàn bộ thành tiền đang giữ của {p?.name}.</div>}
          {allocs.map((a) => {
            const sh = ix.shareById.get(a.shareId);
            const t = sh ? ix.tx.get(sh.transactionId) : undefined;
            return (
              <div className="line" key={a.id}>
                <span className="grow">{t ? `${txTitle(ix, t)} · ${fmtDayMonth(t.date)}` : 'Khoản đã xóa'}{a.kind === 'forgive' ? ' · bạn bỏ qua' : ''}</span>
                <span className="num">−{money(a.amount)}</span>
              </div>
            );
          })}
          {gift > 0 && <div className="line"><span className="grow">{p?.name} cho luôn (thu nhập)</span><span className="num c-income">+{money(gift)}</span></div>}
          <div className="row"><button type="button" className="btn sm danger" onClick={remove}>{out ? 'Xóa lần trả lại' : 'Xóa lần nhận'}</button></div>
        </div>
      )}
    </div>
  );
}

/** Một dòng thu nhập (BR-20): sửa được mọi trường, xóa có hoàn tác. */
export function IncomeRow({ ix, income, onEdit, compact }: { ix: Index; income: Income; onEdit?: (r: Income) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const run = useRun();
  const toast = useToast();
  const root = rootOf(ix, income.categoryId);
  const p = income.personId ? ix.person.get(income.personId) : undefined;
  const mask = useMask();
  const remove = async () => {
    const stamp = await run(() => deleteIncome(db, income.id));
    if (!stamp) return;
    toast({ text: `Đã xóa khoản thu ${mask(money(income.amount))}`, action: { label: 'Hoàn tác', run: () => run(() => restoreIncome(db, income.id, stamp)) } }, 10_000);
  };
  return (
    <div>
      <button type="button" className="item item-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        {compact
          ? <span className="xs muted" style={{ width: 44, flexShrink: 0 }}>{fmtDayMonth(income.date)}</span>
          : <span className="avatar c-income" style={{ width: 40, height: 40, ['--av' as string]: 'var(--income)' }} aria-hidden="true"><Icon name={root?.icon ?? 'wallet'} size={18} /></span>}
        <span className="grow stack tight">
          <span className="title">{income.title || categoryPath(ix, income.categoryId)}</span>
          <span className="meta">Thu nhập · {categoryPath(ix, income.categoryId)}{p ? ` · từ ${p.name}` : ''}</span>
        </span>
        <span className="num c-income">{mask(`+${money(income.amount)}`)}</span>
      </button>
      {open && (
        <div className="detail">
          <div className="xs muted">Ngày {fmtDate(income.date)}{p ? ` · ${p.name} cho` : ''}</div>
          <div className="row">
            {onEdit && <button type="button" className="btn sm" onClick={() => onEdit(income)}>Sửa</button>}
            <button type="button" className="btn sm" onClick={() => nav(`/them?loai=thu&copy=${income.id}`)}>Nhân bản</button>
            <button type="button" className="btn sm danger" onClick={remove}>Xóa</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Một lần trả nợ bằng tiền (UC-16): tính là một giao dịch tiền ra. Xóa có hoàn tác (khoản nợ quay lại). */
export function RepayRow({ ix, rp, compact }: { ix: Index; rp: RepayTx; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const run = useRun();
  const toast = useToast();
  const mask = useMask();
  const p = ix.person.get(rp.personId);
  const inc = rp.incomeId ? ix.incomes.find((r) => r.id === rp.incomeId) : undefined;
  const how = rp.mode === 'hold' ? `giữ lại cho ${p?.name ?? '?'}` : 'chuyển khoản';
  const meta = ['Trả nợ', how, inc ? `từ ${inc.title || categoryPath(ix, inc.categoryId)}` : '', rp.note ?? ''].filter(Boolean).join(' · ');
  const remove = async () => {
    if (!confirm(`Xóa lần trả nợ ${money(rp.amount)} cho ${p?.name}? Khoản nợ quay lại${rp.mode === 'hold' ? ', tiền đang giữ giảm theo' : ''}.`)) return;
    if (!(await run(() => deleteRepayments(db, rp.ids)))) return;
    toast({ text: `Đã xóa lần trả nợ ${money(rp.amount)}`, action: { label: 'Hoàn tác', run: () => run(() => restoreRepayments(db, rp.ids)) } }, 10_000);
  };
  return (
    <div>
      <button type="button" className="item item-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        {compact
          ? <span className="xs muted" style={{ width: 44, flexShrink: 0 }}>{fmtDayMonth(rp.date)}</span>
          : <span className="avatar" style={{ width: 40, height: 40, ['--av' as string]: 'var(--give)' }} aria-hidden="true"><Icon name="outgo" size={18} /></span>}
        <span className="grow stack tight">
          <span className="title">Trả nợ {p?.name ?? '?'}</span>
          <span className="meta">{meta}</span>
        </span>
        {!compact && <span className="hide-sm row" style={{ gap: 4 }}><Pill kind={rp.mode === 'hold' ? 'in' : 'give'}>{rp.mode === 'hold' ? 'Giữ lại' : 'Chuyển khoản'}</Pill></span>}
        <span className="num">−{mask(money(rp.amount))}</span>
      </button>
      {open && (
        <div className="detail">
          <div className="xs muted">
            Ngày {fmtDate(rp.date)} · còn nợ {p?.name} {mask(money(owedTo(ix, rp.personId)))}
            {rp.mode === 'hold' ? ` · tiền vẫn trong tài khoản, thành tiền đang giữ của ${p?.name}` : ''}
          </div>
          {inc && <div className="xs muted">Gắn với khoản thu này: xóa khoản thu thì lần trả nợ xóa theo.</div>}
          <div className="row"><button type="button" className="btn sm danger" onClick={remove}>Xóa lần trả nợ</button></div>
        </div>
      )}
    </div>
  );
}
