import { useState } from 'react';
import type { MonthPoint } from '../domain/stats';
import { money, short, useMask, usePrivacy } from './format';

const H = 200;
/** Nhãn trục gọn: 204.545 → "205k", 15.000.000 → "15tr". */
const k = (v: number) => (v >= 1_000_000 ? short(Math.round(v / 100_000) * 100_000) : `${Math.round(v / 1000)}k`);

/**
 * BR-17 + BR-22: mỗi tháng 2 cột — Thu nhập và Chi tiêu của tôi; rê chuột xem Còn lại; bấm cột mở tháng đó.
 */
export default function YearChart({ months, current, onOpen }: {
  months: MonthPoint[]; current: string; onOpen: (month: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const { hidden } = usePrivacy();
  const mask = useMask();
  // Chế độ ẩn: bỏ cột thu nhập, thang đo chỉ theo tiền ra.
  const max = Math.max(1, ...months.map((m) => Math.max(hidden ? 0 : m.income, m.spent)));
  const nice = (() => {
    const p = 10 ** Math.floor(Math.log10(max));
    return [1, 2, 2.5, 5, 10].map((f) => f * p).find((v) => v >= max) ?? max;
  })();
  const y = (v: number) => (v / nice) * H;
  const h = hover !== null ? months[hover] : null;
  const bar = (v: number) => (v > 0 ? Math.max(3, y(v)) : 0);

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="legend" aria-hidden="true">
        {!hidden && <span><i style={{ background: 'var(--chart-in)' }} />Thu nhập</span>}
        <span><i style={{ background: 'var(--chart-out)' }} />Chi tiêu</span>
      </div>
      <div className="ychart">
        <div className="ychart-plot" style={{ height: H }} onMouseLeave={() => setHover(null)}>
          <div className="ychart-grid" style={{ bottom: y(nice) - 1 }}><span>{k(nice)}</span></div>
          <div className="ychart-grid" style={{ bottom: y(nice / 2) - 1 }}><span>{k(nice / 2)}</span></div>
          {months.map((m, i) => {
            const future = m.month > current;
            return (
              <button type="button" key={m.month} className="ychart-col" disabled={future}
                aria-label={`Tháng ${i + 1}: thu nhập ${mask(money(m.income))}, chi tiêu ${money(m.spent)}, còn lại ${mask(money(m.net))}`}
                aria-current={m.month === current ? 'date' : undefined}
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                onClick={() => onOpen(m.month)}>
                {!hidden && <span className="ychart-bar in" style={{ height: bar(m.income) }} />}
                <span className="ychart-bar out" style={{ height: bar(m.spent) }} />
              </button>
            );
          })}
          {h && hover !== null && (
            <div className="ychart-tip" role="status"
              style={hover < 6
                ? { top: 0, left: `calc(${((hover + 1) / 12) * 100}% + 6px)` }
                : { top: 0, left: `calc(${(hover / 12) * 100}% - 6px)`, transform: 'translateX(-100%)' }}>
              <strong>Tháng {hover + 1}</strong>
              <span><i style={{ background: 'var(--chart-in)' }} />Thu nhập <b>{mask(money(h.income))}</b></span>
              <span><i style={{ background: 'var(--chart-out)' }} />Chi tiêu <b>{money(h.spent)}</b></span>
              {h.advanced > 0 && <span className="muted">Ứng trước {money(h.advanced)} (sẽ thu lại)</span>}
              <span>Còn lại <b>{mask(`${h.net < 0 ? '−' : '+'}${money(Math.abs(h.net))}`)}</b></span>
              <span className="muted">Chi của tôi {money(h.mine)}</span>
            </div>
          )}
        </div>
        <div className="ychart-axis" aria-hidden="true">
          {months.map((m, i) => <span key={m.month} className={m.month === current ? 'cur' : ''}><span className="hide-sm">T</span>{i + 1}</span>)}
        </div>
      </div>
    </div>
  );
}
