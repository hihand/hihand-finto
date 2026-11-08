import { createContext, useCallback, useContext } from 'react';
import type { Transaction } from '../db/schema';
import { formatVND } from '../domain/split';
import { categoryPath, type Index } from '../domain/stats';

export const money = formatVND;

/** 90000 → "90k", 1500000 → "1,5tr". */
export function short(n: number) {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${(n / 1_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}tr`;
  if (a >= 1000 && a % 1000 === 0) return `${n / 1000}k`;
  return formatVND(n);
}

export const STATUS_LABEL = { paid: 'Đã trả', partial: 'Trả một phần', open: 'Đang chờ' } as const;

export function txTitle(ix: Index, tx: Transaction) {
  return tx.title || tx.productName || categoryPath(ix, tx.categoryId);
}

/** BR-18: "An chuyển dư 60k (tháng 11)" — ghi chú tiền dư cuối tháng mới nhất. */
export function noteText(ix: Index, personId: string) {
  const n = ix.lastNote.get(personId);
  if (!n) return '';
  return `${ix.person.get(personId)?.name ?? ''} chuyển dư ${short(n.creditAmount)} (tháng ${Number(n.month.slice(5, 7))}/${n.month.slice(0, 4)})`;
}

/* ---------- Ẩn số nhạy cảm ---------- */

export const MASK = '•••••';
export const PrivacyCtx = createContext<{ hidden: boolean; toggle: () => void }>({ hidden: false, toggle: () => {} });
export const usePrivacy = () => useContext(PrivacyCtx);
/** Che một chuỗi số tiền khi đang bật chế độ ẩn (thu nhập, số dư, còn lại). */
export function useMask() {
  const { hidden } = usePrivacy();
  return useCallback((s: string) => (hidden ? MASK : s), [hidden]);
}

/* ---------- Thông báo + hoàn tác ---------- */

export interface Toast { text: string; action?: { label: string; run: () => void }; error?: boolean }
export const ToastCtx = createContext<(t: Toast, ms?: number) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

/**
 * Chạy một thao tác ghi; lỗi hiện thành thông báo và trả về undefined.
 * Thao tác thành công không trả gì thì trả về true, để người gọi phân biệt được thành công / thất bại.
 */
export function useRun() {
  const toast = useToast();
  return useCallback(async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    try {
      const r = await fn();
      if (ok) toast({ text: ok });
      return (r ?? true) as T;
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
      return undefined;
    }
  }, [toast]);
}
