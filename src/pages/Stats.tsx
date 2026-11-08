import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { fmtDayMonth, fmtDate, monthLabel, periodOf, periodRange, shiftMonth, today } from '../domain/period';
import { balanceAt, periodStats, personalBalanceAt, yearStats } from '../domain/stats';
import { useIndex } from '../ui/data';
import { Empty, Icon, Segmented, SplitBar } from '../ui/kit';
import { money, txTitle, useMask } from '../ui/format';
import YearChart from '../ui/YearChart';

/** BR-12, BR-17, UC-07: thống kê tháng/năm — danh mục → danh mục con → từng giao dịch; theo tag; 12 tháng. */
export default function Stats() {
  const ix = useIndex();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<string | null>(null);
  const mask = useMask();
  if (!ix) return <p className="muted">Đang tải…</p>;

  const current = periodOf(today(), ix.startDay);
  const isYear = params.has('y');
  const month = params.get('m') ?? current;
  const year = Number(params.get('y') ?? month.slice(0, 4));
  const range = periodRange(month, ix.startDay);
  const ys = isYear ? yearStats(ix, year, current) : null;
  const st = ys ? ys.stats : periodStats(ix, range);
  const label = isYear ? `Năm ${year}` : monthLabel(month);
  const go = (n: number) => {
    setOpen(null);
    setParams(isYear ? { y: String(year + n) } : { m: shiftMonth(month, n) }, { replace: true });
  };
  const setMode = (m: 'month' | 'year') => {
    setOpen(null);
    setParams(m === 'year' ? { y: month.slice(0, 4) } : { m: year === Number(current.slice(0, 4)) ? current : `${year}-12` }, { replace: true });
  };
  const maxTag = Math.max(1, ...st.byTag.map((t) => t.amount));
  const pct = (n: number) => (st.mine ? `${Math.round((n / st.mine) * 100)}%` : '0%');
  const endBefore = isYear ? periodRange(`${year + 1}-01`, ix.startDay).from : range.to;
  const endBalance = balanceAt(ix, endBefore);
  const endPersonal = personalBalanceAt(ix, endBefore);
  const giveAll = st.give + st.forgiven;
  const maxInc = Math.max(1, ...st.incomeByCategory.map((g) => g.amount));
  const endDay = (() => { const d = new Date(range.to + 'T00:00:00'); d.setDate(d.getDate() - 1); return d; })();

  return (
    <>
      <div className="page-head">
        <div className="stack tight">
          <h1>Thống kê</h1>
          {!isYear && ix.startDay !== 1 && <span className="small muted">Kỳ {fmtDate(range.from)} – {fmtDate(today(endDay))}</span>}
        </div>
        <div className="row">
          <div className="period">
            <button type="button" className="icon-btn" aria-label={isYear ? 'Năm trước' : 'Tháng trước'} onClick={() => go(-1)}><Icon name="left" /></button>
            <span>{label}</span>
            <button type="button" className="icon-btn" aria-label={isYear ? 'Năm sau' : 'Tháng sau'} onClick={() => go(1)}><Icon name="right" /></button>
          </div>
          <div style={{ width: 180 }}>
            <Segmented label="Xem theo" value={isYear ? 'year' : 'month'} onChange={setMode} options={[['month', 'Tháng'], ['year', 'Năm']]} />
          </div>
        </div>
      </div>

      <div className="grid-kpi" aria-label="Dòng tiền">
        <div className="card stack tight"><span className="kpi-label">Thu nhập</span><span className="kpi-value c-income">{mask(`+${money(st.income)}`)}</span><span className="kpi-sub">{st.incomeByCategory.length} nguồn thu</span></div>
        <div className="card stack" style={{ gap: 6 }}>
          <span className="kpi-label">Chi tiêu của tôi</span>
          <span className="kpi-value">{st.spent ? '−' : ''}{money(st.spent)}</span>
          <SplitBar mine={st.spent - giveAll} give={giveAll} owe={0} />
          <span className="kpi-sub">Của tôi + Cho đi · tiền mất thật</span>
        </div>
        <div className="card stack tight">
          <span className="kpi-label">Còn lại {isYear ? 'trong năm' : 'trong tháng'}</span>
          <span className={`kpi-value ${st.net < 0 ? 'c-give' : ''}`}>{mask(`${st.net < 0 ? '−' : '+'}${money(Math.abs(st.net))}`)}</span>
          <span className="kpi-sub">Thu nhập − chi tiêu của tôi · không tính ứng trước, chi hộ</span>
        </div>
        <div className="card hero stack tight">
          <span className="kpi-label">Số dư cuối {isYear ? 'năm' : 'kỳ'}</span>
          {endBalance === null
            ? <><span className="kpi-value muted">—</span><Link to="/cai-dat?tab=chung" className="small strong">Đặt số dư ban đầu ›</Link></>
            : <><span className={`kpi-value ${endBalance < 0 ? 'c-give' : ''}`}>{mask(money(endBalance))}</span><span className="kpi-sub">tài khoản · của tôi {mask(money(endPersonal ?? 0))}</span></>}
        </div>
      </div>

      <div className="grid-kpi">
        <div className="card stack tight"><span className="kpi-label">Thực chi cho bản thân</span><span className="kpi-value c-mine">{money(st.mine)}</span><span className="kpi-sub">{st.spent ? Math.round((st.mine / st.spent) * 100) : 0}% chi tiêu{ys ? ` · TB ${money(ys.average)}/tháng` : ''}</span></div>
        <div className="card stack tight"><span className="kpi-label">Cho đi</span><span className="kpi-value c-give">{money(giveAll)}</span><span className="kpi-sub">{st.giveByPerson.length} người{st.forgiven ? ` · gồm ${money(st.forgiven)} bỏ qua` : ''}</span></div>
        <div className="card stack tight"><span className="kpi-label">Ứng trước (sẽ thu lại)</span><span className="kpi-value c-owe">{money(st.advanced)}</span><span className="kpi-sub">phần chưa có tiền giữ bù{st.onBehalf ? ` · chi hộ ${money(st.onBehalf)} (trừ tiền giữ)` : ''}</span></div>
        <div className="card stack tight"><span className="kpi-label">Tiền ra tài khoản</span><span className="kpi-value">{money(st.total)}</span><span className="kpi-sub">gồm cả chi hộ, ứng trước · nhận vào (trả lại, gửi giữ) +{money(st.received)}{st.returned ? ` · trả lại tiền giữ −${money(st.returned)}` : ''}</span></div>
      </div>

      {ys && (
        <section className="card stack">
          <div className="row between">
            <div className="stack tight">
              <h2>Thu nhập và chi tiêu từng tháng</h2>
              <span className="small muted">Rê chuột để xem còn lại từng tháng · bấm cột để mở tháng đó</span>
            </div>
          </div>
          <YearChart months={ys.months} current={current} onOpen={(m) => setParams({ m })} />
        </section>
      )}

      <div className="cols">
        <section className="card stack col-main">
          <div className="row between"><h2>Chi của tôi theo danh mục</h2><span className="xs muted">{label} · bấm để xổ chi tiết</span></div>
          {st.byCategory.length === 0 && <Empty>{isYear ? 'Năm này' : 'Tháng này'} chưa có chi tiêu cho bản thân.</Empty>}
          <div className="list">
            {st.byCategory.map((c) => {
              const isOpen = open === c.id;
              return (
                <div key={c.id}>
                  <button type="button" className="item item-btn" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : c.id)}>
                    <span className="row nowrap" style={{ gap: 10 }}>
                      <Icon name={c.icon} size={18} />
                      <span className="grow strong">{c.name}</span>
                      <span className="xs muted">{pct(c.amount)}</span>
                      <span className="num">{money(c.amount)}</span>
                      <Icon name="chevron" size={16} />
                    </span>
                    <span className="bar"><span style={{ width: pct(c.amount) }} /></span>
                  </button>
                  {isOpen && (
                    <div className="detail" style={{ marginLeft: 0 }}>
                      {c.subs.map((s) => (
                        <div key={s.id} className="stack tight">
                          <div className="row between strong small"><span>{s.name}</span><span className="num">{money(s.amount)}</span></div>
                          {s.items.map((it) => (
                            <div className="line" key={it.tx.id}>
                              <span className="xs muted" style={{ width: 40 }}>{fmtDayMonth(it.tx.date)}</span>
                              <span className="grow">{txTitle(ix, it.tx)}{it.tx.productName && it.tx.title ? <span className="muted"> · {it.tx.productName}</span> : null}</span>
                              <span className="num">{money(it.amount)}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <div className="col-side">
          <section className="card stack">
            <div className="row between"><h2>Thu nhập theo nguồn</h2><span className="num c-income">{mask(`+${money(st.income)}`)}</span></div>
            {st.incomeByCategory.length === 0 && <Empty>Chưa ghi khoản thu nào. <Link to="/them?loai=thu">Thêm thu nhập</Link>.</Empty>}
            {st.incomeByCategory.map((g) => (
              <div key={g.id} className="stack tight">
                <div className="row between"><span className="strong small">{g.name}</span><span className="num small">{mask(money(g.amount))}</span></div>
                <div className="bar"><span style={{ width: `${(g.amount / maxInc) * 100}%`, background: 'var(--chart-in)' }} /></div>
                {g.subs.length > 1 || g.subs[0]?.name !== 'Chung'
                  ? <span className="xs muted">{g.subs.map((x) => `${x.name} ${mask(money(x.amount))}`).join(' · ')}</span> : null}
              </div>
            ))}
          </section>
          <section className="card stack">
            <h2>Theo tag (phần của tôi)</h2>
            {st.byTag.length === 0 && <Empty>Chưa có tag nào.</Empty>}
            {st.byTag.map((t) => (
              <div key={t.tag.id} className="stack tight">
                <div className="row between"><span className="strong small">#{t.tag.name}</span><span className="num small">{money(t.amount)}</span></div>
                <div className="bar"><span style={{ width: `${(t.amount / maxTag) * 100}%`, background: 'var(--owe)' }} /></div>
              </div>
            ))}
            {st.byTag.length > 1 && <span className="xs muted">Một giao dịch nhiều tag được tính đủ vào mỗi tag (RULE-12).</span>}
          </section>
          <section className="card stack">
            <div className="row between"><h2>Cho đi {label.toLowerCase()}</h2><span className="num c-give">{giveAll ? '−' : ''}{money(giveAll)}</span></div>
            {st.giveByPerson.map((g) => (
              <div className="row between" key={g.personId}><span>{ix.person.get(g.personId)?.name}</span><span className="num">−{money(g.amount)}</span></div>
            ))}
            <Link to="/moi-nguoi" className="small strong">Xem chi tiết từng người ›</Link>
          </section>
        </div>
      </div>
    </>
  );
}
