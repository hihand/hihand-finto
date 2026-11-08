import type { ShareType } from '../db/schema';

export interface Participant {
  personId: string | null; // null = tôi
  type: ShareType; // 'mine' cho tôi, 'owe' | 'give' cho người khác
  amount?: number; // chỉ dùng khi chia tùy chỉnh
}

export interface ShareDraft {
  personId: string | null;
  type: ShareType;
  amount: number;
}

/** Gõ "360k" / "360.000" / "1,5tr" → số đồng. */
export function parseAmount(input: string): number {
  const s = input.trim().toLowerCase().replace(/\s/g, '');
  const m = s.match(/^([\d.,]+)(k|tr|m)?$/);
  if (!m) return 0;
  const unit = m[2];
  let num = m[1];
  if (unit) num = num.replace(',', '.');
  else num = num.replace(/[.,]/g, '');
  const v = parseFloat(num);
  if (!isFinite(v)) return 0;
  const mul = unit === 'k' ? 1_000 : unit === 'tr' || unit === 'm' ? 1_000_000 : 1;
  return Math.round(v * mul);
}

export const formatVND = (n: number) => `${Math.round(n).toLocaleString('vi-VN')}đ`;

/**
 * RULE-03: chia đều, làm tròn xuống 1.000đ; phần lẻ vào phần Của tôi
 * (không có tôi thì vào người đầu tiên).
 */
export function splitEqual(total: number, people: Participant[]): ShareDraft[] {
  if (people.length === 0) throw new Error('Cần ít nhất một người');
  const each = Math.floor(total / people.length / 1000) * 1000;
  const shares = people.map((p) => ({ personId: p.personId, type: p.personId === null ? 'mine' as const : p.type, amount: each }));
  const rest = total - each * people.length;
  const idx = Math.max(0, shares.findIndex((s) => s.personId === null));
  shares[idx].amount += rest;
  return shares;
}

/** Chia tùy chỉnh: người đã nhập giữ số; "Chia phần còn lại" chia đều phần chưa phân cho người chưa nhập. */
export function splitRemaining(total: number, people: Participant[]): ShareDraft[] {
  const fixed = people.filter((p) => p.amount != null && p.amount > 0);
  const open = people.filter((p) => !(p.amount != null && p.amount > 0));
  const used = fixed.reduce((a, p) => a + (p.amount ?? 0), 0);
  const rest = total - used;
  if (rest < 0) throw new Error('Tổng đã nhập vượt tổng bill');
  const openShares = open.length ? splitEqual(rest, open) : [];
  return people.map((p) => {
    const f = fixed.find((x) => x === p);
    if (f) return { personId: p.personId, type: p.personId === null ? 'mine' : p.type, amount: p.amount! };
    return openShares.find((s) => s.personId === p.personId)!;
  });
}

export function assertBalanced(total: number, shares: ShareDraft[]) {
  const sum = shares.reduce((a, s) => a + s.amount, 0);
  if (sum !== total) throw new Error(`Tổng các phần (${sum}) phải bằng tổng bill (${total})`);
  if (shares.some((s) => s.amount < 0)) throw new Error('Phần chia không được âm');
}
