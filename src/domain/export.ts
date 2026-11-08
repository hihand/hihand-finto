import type { Sheet } from '../lib/xlsx';
import { inRange } from './period';
import { rootOf, statusOf, type Index } from './stats';

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
        s.personId ? ix.person.get(s.personId)?.name ?? '' : 'Tôi', TYPE[s.type], s.amount,
        paid, paid === null ? null : s.amount - Math.min(s.amount, ix.paid.get(s.id) ?? 0), s.type === 'owe' ? STATUS[statusOf(ix, s)] : '',
        s.type === 'mine' ? (root?.countsAsMine ?? true ? 'Có' : 'Không') : '',
      ];
    });
  });
  const sts = ix.settlements.filter((s) => inR(s.date)).sort((a, b) => a.date.localeCompare(b.date));
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
  ];
}
