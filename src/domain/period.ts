/** Ngày dạng YYYY-MM-DD theo giờ máy (không dùng toISOString vì lệch múi giờ). */
export function today(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** NFR-08: ngày hiển thị dd/mm/yyyy. */
export const fmtDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
export const fmtDayMonth = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
export const weekday = (iso: string) => WD[new Date(iso + 'T00:00:00').getDay()];

/** Cộng n tháng vào nhãn kỳ YYYY-MM. */
export function shiftMonth(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}

const clampDay = (d: number) => Math.min(28, Math.max(1, Math.floor(d) || 1));

/**
 * RULE-11: kỳ "tháng M" bắt đầu ngày startDay của tháng M, kết thúc trước ngày startDay của tháng M+1.
 * Trả về [from, to) dạng YYYY-MM-DD.
 */
export function periodRange(month: string, startDay = 1): { from: string; to: string } {
  const d = String(clampDay(startDay)).padStart(2, '0');
  return { from: `${month}-${d}`, to: `${shiftMonth(month, 1)}-${d}` };
}

/** Kỳ chứa một ngày. */
export function periodOf(date: string, startDay = 1): string {
  const month = date.slice(0, 7);
  return Number(date.slice(8, 10)) >= clampDay(startDay) ? month : shiftMonth(month, -1);
}

export const inRange = (date: string, r: { from: string; to: string }) => date >= r.from && date < r.to;

export const monthLabel = (month: string) => `Tháng ${Number(month.slice(5, 7))}, ${month.slice(0, 4)}`;
