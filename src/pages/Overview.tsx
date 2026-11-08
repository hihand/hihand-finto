import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fmtDate, fmtDayMonth, monthLabel, periodOf, periodRange, today } from '../domain/period';
import { balanceAt, creditOf, outstanding, periodStats, personalBalanceAt, type Index } from '../domain/stats';
import { useIndex } from '../ui/data';
import { Avatar, Empty, Icon, SplitBar } from '../ui/kit';
import { money, short, txTitle, useMask, usePrivacy, useRun } from '../ui/format';
import { downloadBackup } from '../ui/download';
import { backupOverdueDays } from '../domain/monthEnd';
import { IncomeRow, TxRow } from '../ui/tx';

const holdingSum = (ix: Index) => ix.people.reduce((a, p) => a + creditOf(ix, p.id), 0);

export default function Overview() {
  const ix = useIndex();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [openGive, setOpenGive] = useState<string | null>(null);
  const [later, setLater] = useState(false);
  const run = useRun();
  const mask = useMask();
  const { hidden } = usePrivacy();
  if (!ix) return <p className="muted">Đang tải…</p>;

  const month = periodOf(today(), ix.startDay);
  const st = periodStats(ix, periodRange(month, ix.startDay));
  const owes = outstanding(ix);
  const oweTotal = owes.reduce((a, o) => a + o.amount, 0);
  const holding = ix.people.map((p) => ({ p, credit: creditOf(ix, p.id) })).filter((x) => x.credit > 0);
  const maxCat = Math.max(1, ...st.byCategory.map((c) => c.amount));
  const recent = [
    ...ix.txs.slice(0, 8).map((t) => ({ key: t.id, date: t.date, created: t.createdAt, el: <TxRow key={t.id} ix={ix} tx={t} compact /> })),
    ...ix.incomes.filter((r) => !r.settlementId).slice(0, 8).map((r) => ({ key: r.id, date: r.date, created: r.createdAt, el: <IncomeRow key={r.id} ix={ix} income={r} compact /> })),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created)).slice(0, 8);
  const balance = balanceAt(ix);
  const personal = personalBalanceAt(ix);
  const giveAll = st.give + st.forgiven;
  const totalHeld = holdingSum(ix);
  const firstData = ix.txs.reduce<string | undefined>((a, t) => (!a || t.createdAt < a ? t.createdAt : a), undefined);
  const overdue = later ? 0 : backupOverdueDays(ix.snap.settings?.lastBackupAt, firstData);

  return (
    <>
      <div className="page-head">
        <div className="stack tight">
          <span className="eyebrow">{monthLabel(month)}</span>
          <h1>Tổng quan</h1>
        </div>
        <form className="row" style={{ flex: '1 1 420px', justifyContent: 'flex-end' }}
          onSubmit={(e) => { e.preventDefault(); nav(`/giao-dich?q=${encodeURIComponent(q)}`); }}>
          <label className="search" style={{ maxWidth: 360 }}>
            <Icon name="search" size={18} />
            <span className="sr-only">Tìm giao dịch</span>
            <input className="input" placeholder="Tìm giao dịch, người, tag…" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <Link to="/them?loai=thu" className="btn" style={{ color: 'var(--income)' }}><Icon name="plus" size={18} stroke={2.5} />Thu nhập</Link>
          <Link to="/them" className="btn primary"><Icon name="plus" size={18} stroke={2.5} />Thêm chi tiêu</Link>
        </form>
      </div>

      {overdue > 0 && (
        <div className="banner" role="status">
          <span className="grow">
            <b>{ix.snap.settings?.lastBackupAt ? `Đã ${overdue} ngày chưa sao lưu.` : 'Bạn chưa sao lưu lần nào.'}</b>{' '}
            Dữ liệu chỉ nằm trong trình duyệt này; xóa dữ liệu trình duyệt là mất.
          </span>
          <button type="button" className="btn sm" onClick={() => setLater(true)}>Để sau</button>
          <button type="button" className="btn sm primary" onClick={() => run(downloadBackup, 'Đã tải file sao lưu')}>Sao lưu ngay</button>
        </div>
      )}

      <div className="grid-kpi" aria-label="Dòng tiền tháng này">
        <div className="card hero stack" style={{ gap: 6 }}>
          <span className="kpi-label">Số dư tài khoản</span>
          {balance === null ? (
            <>
              <span className="kpi-value muted">—</span>
              <Link to="/cai-dat?tab=chung" className="small strong">Đặt số dư ban đầu để biết bạn đang có bao nhiêu ›</Link>
            </>
          ) : (
            <>
              <span className={`kpi-value ${balance < 0 ? 'c-give' : ''}`}>{mask(money(balance))}</span>
              <span className="kpi-sub">Khớp tài khoản ngân hàng · tính từ {fmtDate(ix.snap.settings!.openingDate!)}</span>
            </>
          )}
        </div>
        <div className="card stack tight">
          <span className="kpi-label">Số dư của tôi</span>
          {personal === null ? <span className="kpi-value muted">—</span> : (
            <>
              <span className={`kpi-value c-mine ${personal < 0 ? 'c-give' : ''}`}>{mask(money(personal))}</span>
              <span className="kpi-sub">
                {totalHeld > 0 ? `= tài khoản − ${short(totalHeld)} giữ hộ` : 'Không giữ hộ ai'}
                {oweTotal > 0 ? ` · đang đòi lại ${short(oweTotal)} sẽ về` : ''}
              </span>
            </>
          )}
        </div>
        <div className="card stack tight">
          <span className="kpi-label">Thu nhập tháng này</span>
          <span className="kpi-value c-income">{mask(`+${money(st.income)}`)}</span>
          <span className="kpi-sub">{st.incomeByCategory.slice(0, 2).map((g) => `${g.name} ${mask(short(g.amount))}`).join(' · ') || 'Chưa ghi khoản thu nào'}</span>
        </div>
        <div className="card stack tight">
          <span className="kpi-label">Còn lại tháng này</span>
          <span className={`kpi-value ${st.net < 0 ? 'c-give' : ''}`}>{mask(`${st.net < 0 ? '−' : '+'}${money(Math.abs(st.net))}`)}</span>
          <span className="kpi-sub">Thu nhập − chi tiêu của tôi · không tính ứng trước, chi hộ</span>
        </div>
      </div>

      <div className="grid-kpi" aria-label="Chi tiêu tháng này">
        <div className="card stack" style={{ gap: 6 }}>
          <span className="kpi-label">Chi tiêu tháng này</span>
          <span className="kpi-value">{st.spent ? '−' : ''}{money(st.spent)}</span>
          <SplitBar mine={st.spent - giveAll} give={giveAll} owe={0} />
          <span className="legend">
            <span><i style={{ background: 'var(--primary)' }} />Bản thân</span>
            <span><i style={{ background: 'var(--give)' }} />Cho đi</span>
          </span>
          {(st.advanced > 0 || st.onBehalf > 0) && (
            <span className="kpi-sub">{[st.advanced ? `ứng trước ${short(st.advanced)} sẽ thu lại` : '', st.onBehalf ? `chi hộ ${short(st.onBehalf)}` : ''].filter(Boolean).join(' · ')} — không tính</span>
          )}
        </div>
        <div className="card stack tight">
          <span className="kpi-label">Thực chi cho bản thân</span>
          <span className="kpi-value c-mine">{money(st.mine)}</span>
          <span className="kpi-sub">{st.spent ? Math.round((st.mine / st.spent) * 100) : 0}% chi tiêu{!hidden && st.income && st.mine <= st.income ? ` · ${Math.round((st.mine / st.income) * 100)}% thu nhập` : ''}</span>
        </div>
        <div className="card stack tight">
          <span className="kpi-label">Cho đi</span>
          <span className="kpi-value c-give">{money(giveAll)}</span>
          <span className="kpi-sub">{st.giveByPerson.length} người{st.forgiven ? ` · gồm ${short(st.forgiven)} bỏ qua` : ' · không cần trả lại'}</span>
        </div>
        <div className="card stack tight">
          <span className="kpi-label">Đang đòi lại</span>
          <span className="kpi-value c-owe">{money(oweTotal)}</span>
          <span className="kpi-sub">{owes.length} người chưa trả</span>
        </div>
      </div>

      <div className="cols">
        <div className="col-main">
          <section className="card stack">
            <div className="row between"><h2>Giao dịch gần đây</h2><Link to="/giao-dich" className="small strong">Xem tất cả</Link></div>
            {recent.length === 0
              ? <Empty>Chưa có giao dịch. <Link to="/them">Thêm khoản chi đầu tiên</Link>.</Empty>
              : <div className="list">{recent.map((r) => r.el)}</div>}
          </section>
          <section className="card stack">
            <div className="row between"><h2>Chi của tôi theo danh mục</h2><Link to="/thong-ke" className="small strong">Thống kê ›</Link></div>
            {st.byCategory.length === 0 && <Empty>Tháng này chưa có chi tiêu cho bản thân.</Empty>}
            {st.byCategory.map((c) => (
              <div key={c.id} className="stack tight">
                <div className="row between"><span className="strong small">{c.name}</span><span className="num small">{money(c.amount)}</span></div>
                <div className="bar"><span style={{ width: `${(c.amount / maxCat) * 100}%` }} /></div>
              </div>
            ))}
          </section>
        </div>

        <div className="col-side">
          <section className="card stack">
            <div className="row between"><h2>Cho đi tháng này</h2><span className="num c-give">{giveAll ? '−' : ''}{money(giveAll)}</span></div>
            {st.giveByPerson.length === 0 && <Empty>Chưa cho ai khoản nào.</Empty>}
            <div className="list">
              {st.giveByPerson.map((g) => {
                const p = ix.person.get(g.personId);
                const open = openGive === g.personId;
                return (
                  <div key={g.personId}>
                    <button type="button" className="item item-btn" aria-expanded={open} onClick={() => setOpenGive(open ? null : g.personId)}>
                      <Avatar person={p} />
                      <span className="grow stack tight"><span className="title">{p?.name}</span><span className="meta">{g.items.length} khoản</span></span>
                      <span className="num">−{money(g.amount)}</span>
                      <Icon name="chevron" size={16} />
                    </button>
                    {open && (
                      <div className="detail">
                        {g.items.map((it) => (
                          <div className="line" key={it.tx.id}>
                            <span className="xs muted" style={{ width: 40 }}>{fmtDayMonth(it.tx.date)}</span>
                            <span className="grow">{txTitle(ix, it.tx)}</span>
                            <span className="num">−{money(it.amount)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card stack">
            <div className="row between"><h2>Đang đòi lại</h2><span className="num c-owe">{money(oweTotal)}</span></div>
            {owes.length === 0 && <Empty>Không ai nợ bạn.</Empty>}
            <div className="list">
              {owes.map((o) => {
                const p = ix.person.get(o.personId);
                return (
                  <div className="item" key={o.personId}>
                    <Avatar person={p} />
                    <span className="grow stack tight"><span className="title">{p?.name}</span><span className="meta">{o.count} khoản · cũ nhất {fmtDayMonth(o.oldest)}</span></span>
                    <span className="num">{money(o.amount)}</span>
                    <Link to={`/thu-tien?p=${o.personId}`} className="btn sm" style={{ background: 'var(--owe-bg)', color: 'var(--owe)' }}>Thu</Link>
                  </div>
                );
              })}
            </div>
          </section>

          {holding.length > 0 && (
            <section className="card stack">
              <h2>Bạn đang giữ tiền của</h2>
              <div className="list">
                {holding.map(({ p, credit }) => (
                  <div className="item" key={p.id}>
                    <Avatar person={p} />
                    <span className="grow title">{p.name}</span>
                    <span className="num c-income">{short(credit)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
