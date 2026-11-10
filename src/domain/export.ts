import type { Sheet } from '../lib/xlsx';
import { inRange } from './period';
import { debtLedger, oweAmount, rootOf, statusOf, type Index } from './stats';

const TYPE = { mine: 'Của tôi', owe: 'Đòi lại', give: 'Cho đi' } as const;
const STATUS = { paid: 'Đã trả', partial: 'Trả một phần', open: 'Đang chờ' } as const;

/** BR-19: mỗi dòng một phần chia, có loại và người; thêm trang Thu tiền và Thu nhập. range = null là tất cả. */
export function exportSheets(ix: Index, range: { from: string; to: string } | null): Sheet[] {
  const inR = (d: string) => !range || inRange(d, range);
  const txs = ix.txs.filter((t) => inR(t.date)).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  const shareRows = txs.flatMap((t) => {
    const root = rootOf(ix, t.categoryId);
    const sub = ix.category.get(t.categoryId);
    const tags = (ix.tagIdsOfTx.get(t.id) ?? []).map((id) => ix.tag.get(id)?.name ?? '').join(', ');
    return (ix.sharesOfTx.get(t.id) ?? []).map((s) => {
      const paid = s.type === 'owe' ? Math.min(s.amount, ix.paid.get(s.id) ?? 0) : null;
      return [
        { date: t.date }, t.title, root?.name ?? '', sub?.parentId ? sub.name : '', tags, t.productName ?? '',
        t.kind === 'transfer' ? 'Chuyển tiền' : t.onBehalf ? 'Chi hộ' : 'Chi tiêu', t.totalAmount,
        s.personId ? ix.person.get(s.personId)?.name ?? '' : 'Tôi',
        s.type === 'owe' && oweAmount(ix, s) < s.amount ? (oweAmount(ix, s) ? 'Đòi lại + trả nợ (cấn trừ)' : 'Trả nợ (cấn trừ)') : TYPE[s.type], s.amount,
        paid, paid === null ? null : s.amount - Math.min(s.amount, ix.paid.get(s.id) ?? 0), s.type === 'owe' ? STATUS[statusOf(ix, s)] : '',
        s.type === 'mine' ? (root?.countsAsMine ?? true ? 'Có' : 'Không') : '',
      ];
    });
  });
  const sts = ix.settlements.filter((s) => !s.opening && inR(s.date)).sort((a, b) => a.date.localeCompare(b.date));
  const settleRows = sts.map((s) => {
    const allocs = ix.allocsOfSettlement.get(s.id) ?? [];
    const used = allocs.filter((x) => x.kind !== 'forgive').reduce((a, x) => a + x.amount, 0);
    const forgiven = allocs.filter((x) => x.kind === 'forgive').reduce((a, x) => a + x.amount, 0);
    const gift = (ix.giftsOfSettlement.get(s.id) ?? []).reduce((a, r) => a + r.amount, 0);
    const out = s.direction === 'out';
    return [{ date: s.date }, ix.person.get(s.personId)?.name ?? '', out ? 'Trả lại tiền giữ' : 'Nhận',
      out ? -s.amount : s.amount + gift, out ? null : used, out ? null : s.amount - used, gift || null, forgiven || null, s.note ?? ''];
  });
  const incRows = ix.incomes.filter((r) => inR(r.date)).sort((a, b) => a.date.localeCompare(b.date)).map((r) => {
    const root = rootOf(ix, r.categoryId);
    const sub = ix.category.get(r.categoryId);
    return [{ date: r.date }, root?.name ?? '', sub?.parentId ? sub.name : '', r.amount, r.personId ? ix.person.get(r.personId)?.name ?? '' : '', r.title];
  });
  // Công nợ: mọi dòng của sổ nợ (tôi nợ người khác) + các khoản người khác nợ đầu kỳ.
  const debtRows = ix.people.flatMap((p) => debtLedger(ix, p.id).filter((e) => inR(e.date)).map((e) => [
    { date: e.date }, p.name, 'Tôi nợ', e.label, e.delta, e.balance,
  ]));
  for (const t of ix.allTxs) {
    if (!t.opening || !inR(t.date)) continue;
    for (const s of ix.sharesOfTx.get(t.id) ?? []) {
      const paid = Math.min(s.amount, ix.paid.get(s.id) ?? 0);
      debtRows.push([{ date: t.date }, ix.person.get(s.personId ?? '')?.name ?? '', 'Họ nợ tôi', 'Nợ đầu kỳ', s.amount, s.amount - paid]);
    }
  }
  debtRows.sort((a, b) => (a[0] as { date: string }).date.localeCompare((b[0] as { date: string }).date));
  return [
    {
      name: 'Phần chia',
      header: ['Ngày', 'Ghi chú', 'Danh mục', 'Danh mục con', 'Tag', 'Tên sản phẩm', 'Loại giao dịch', 'Tổng bill', 'Người', 'Loại phần', 'Số tiền', 'Đã trả', 'Còn đòi', 'Trạng thái', 'Tính vào Chi của tôi'],
      rows: shareRows,
      widths: [12, 28, 14, 20, 20, 20, 14, 13, 16, 11, 13, 12, 12, 14, 12],
    },
    {
      name: 'Thu tiền',
      header: ['Ngày', 'Người', 'Loại', 'Số tiền', 'Đã trừ vào khoản', 'Thành tiền đang giữ', 'Họ cho luôn', 'Bạn bỏ qua', 'Ghi chú'],
      rows: settleRows,
      widths: [12, 16, 16, 14, 16, 18, 13, 13, 28],
    },
    {
      name: 'Thu nhập',
      header: ['Ngày', 'Danh mục', 'Danh mục con', 'Số tiền', 'Người cho', 'Ghi chú'],
      rows: incRows,
      widths: [12, 16, 16, 14, 16, 28],
    },
    {
      name: 'Công nợ',
      header: ['Ngày', 'Người', 'Chiều', 'Nội dung', 'Số tiền (+ phát sinh / − trả)', 'Còn lại'],
      rows: debtRows,
      widths: [12, 16, 12, 36, 18, 14],
    },
  ];
}
