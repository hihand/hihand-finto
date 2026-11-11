/** YYYY-MM-DD in local time (not toISOString, which shifts the time zone). */
export function today(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** NFR-08: dates shown as dd/mm/yyyy. */
export const fmtDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
export const fmtDayMonth = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
export const weekday = (iso: string) => WD[new Date(iso + 'T00:00:00').getDay()];

/** Add n months to a YYYY-MM period label. */
export function shiftMonth(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}

const clampDay = (d: number) => Math.min(28, Math.max(1, Math.floor(d) || 1));

/**
 * RULE-11: period "month M" starts on startDay of month M and ends before startDay of month M+1.
 * Returns [from, to) as YYYY-MM-DD.
 */
export function periodRange(month: string, startDay = 1): { from: string; to: string } {
  const d = String(clampDay(startDay)).padStart(2, '0');
  return { from: `${month}-${d}`, to: `${shiftMonth(month, 1)}-${d}` };
}

/** The period containing a date. */
export function periodOf(date: string, startDay = 1): string {
  const month = date.slice(0, 7);
  return Number(date.slice(8, 10)) >= clampDay(startDay) ? month : shiftMonth(month, -1);
}

export const inRange = (date: string, r: { from: string; to: string }) => date >= r.from && date < r.to;

export const monthLabel = (month: string) => `Tháng ${Number(month.slice(5, 7))}, ${month.slice(0, 4)}`;
