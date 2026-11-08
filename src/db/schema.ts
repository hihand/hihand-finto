import Dexie, { type EntityTable } from 'dexie';

/** Mọi bảng có id (UUID), createdAt, updatedAt, deletedAt để sau này đồng bộ với app mobile. */
export interface Base {
  id: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  deletedAt?: string | null;
}

export type ShareType = 'mine' | 'owe' | 'give';
export type TxKind = 'expense' | 'transfer';
export type SplitMode = 'equal' | 'custom';

export interface Person extends Base {
  name: string;
  color: string;
  defaultType: 'owe' | 'give';
  note?: string;
  archived?: boolean;
}

export interface Group extends Base {
  name: string;
}

export interface GroupMember extends Base {
  groupId: string;
  personId: string;
}

export interface Category extends Base {
  name: string;
  icon: string;
  parentId: string | null; // null = danh mục chính
  countsAsMine: boolean;
  sortOrder: number;
  /** 'income' = danh mục thu nhập; không có = danh mục chi (dữ liệu cũ). */
  kind?: 'expense' | 'income';
}

export interface Tag extends Base {
  name: string;
}

export interface CategoryTag extends Base {
  categoryId: string;
  tagId: string;
  sortOrder: number;
}

export interface Transaction extends Base {
  date: string; // YYYY-MM-DD
  kind: TxKind;
  categoryId: string; // danh mục con nếu có
  title: string;
  productName?: string;
  /** Chi hộ người khác (UC-12): không có phần Của tôi, trừ vào tiền đang giữ. */
  onBehalf?: boolean;
  totalAmount: number; // đồng, số nguyên
  splitMode: SplitMode;
}

export interface TransactionTag extends Base {
  transactionId: string;
  tagId: string;
}

export interface Share extends Base {
  transactionId: string;
  personId: string | null; // null = tôi
  type: ShareType;
  amount: number;
}

export interface Settlement extends Base {
  personId: string;
  date: string;
  amount: number;
  note?: string;
  /** 'in' (mặc định) = người đó chuyển cho bạn; 'out' = bạn trả lại tiền đang giữ của họ (UC-13). */
  direction?: 'in' | 'out';
}

export interface Allocation extends Base {
  settlementId: string | null; // null = trừ từ tiền đang giữ (hoặc bỏ qua không kèm lần nhận)
  shareId: string;
  personId: string;
  amount: number;
  /** 'pay' (mặc định) = trừ bằng tiền thật; 'forgive' = bạn bỏ qua, phần đó thành Cho đi (UC-10). Không đụng tiền đang giữ. */
  kind?: 'pay' | 'forgive';
  /** Ngày bỏ qua (chỉ với kind 'forgive'). */
  date?: string;
}

/** Một khoản thu nhập: lương, thưởng, được cho… (khác tiền người khác trả lại = settlements). */
export interface Income extends Base {
  date: string; // YYYY-MM-DD
  categoryId: string; // danh mục thu (con nếu có)
  amount: number;
  title: string;
  personId: string | null; // người cho, ví dụ Mẹ; null = không gắn người
  /** Phần dư người đó cho luôn khi trả tiền (UC-09): gắn với lần nhận, xóa lần nhận thì xóa theo. */
  settlementId?: string | null;
}

export interface MonthNote extends Base {
  personId: string;
  month: string; // YYYY-MM
  creditAmount: number;
}

export interface Settings {
  id: 'settings';
  theme: 'dark' | 'light' | 'system';
  monthStartDay: number;
  monthEndNote: boolean;
  autoApplyCredit: boolean;
  seeded: boolean;
  /** Kỳ gần nhất đã chạy ghi chú cuối tháng (YYYY-MM). */
  lastMonthEnd?: string;
  /** Lần sao lưu gần nhất (ISO), để nhắc khi quá 7 ngày (NFR-04). */
  lastBackupAt?: string;
  /** Số dư ban đầu: số tiền đang có tại ngày openingDate (bắt đầu tính số dư). */
  openingBalance?: number;
  openingDate?: string;
  /** Đã tạo danh mục thu mặc định (cho dữ liệu cũ nâng cấp lên). */
  incomeSeeded?: boolean;
  /** Đã tạo danh mục Hóa đơn mặc định (cho dữ liệu cũ). */
  billsSeeded?: boolean;
  /** Ẩn số nhạy cảm (thu nhập, số dư, còn lại) mỗi lần mở app; không có = true. */
  hideOnOpen?: boolean;
}

export class FintoDB extends Dexie {
  people!: EntityTable<Person, 'id'>;
  groups!: EntityTable<Group, 'id'>;
  groupMembers!: EntityTable<GroupMember, 'id'>;
  categories!: EntityTable<Category, 'id'>;
  tags!: EntityTable<Tag, 'id'>;
  categoryTags!: EntityTable<CategoryTag, 'id'>;
  transactions!: EntityTable<Transaction, 'id'>;
  transactionTags!: EntityTable<TransactionTag, 'id'>;
  shares!: EntityTable<Share, 'id'>;
  settlements!: EntityTable<Settlement, 'id'>;
  allocations!: EntityTable<Allocation, 'id'>;
  monthNotes!: EntityTable<MonthNote, 'id'>;
  incomes!: EntityTable<Income, 'id'>;
  settings!: EntityTable<Settings, 'id'>;

  constructor(name = 'hihand-finto') {
    super(name);
    this.version(1).stores({
      people: 'id, name, updatedAt',
      groups: 'id, updatedAt',
      groupMembers: 'id, groupId, personId, updatedAt',
      categories: 'id, parentId, sortOrder, updatedAt',
      tags: 'id, name, updatedAt',
      categoryTags: 'id, categoryId, tagId, updatedAt',
      transactions: 'id, date, categoryId, kind, updatedAt',
      transactionTags: 'id, transactionId, tagId, updatedAt',
      shares: 'id, transactionId, personId, type, updatedAt',
      settlements: 'id, personId, date, updatedAt',
      allocations: 'id, settlementId, shareId, personId, updatedAt',
      monthNotes: 'id, [personId+month], updatedAt',
      settings: 'id',
    });
    // v2: thu nhập. Bảng cũ giữ nguyên; danh mục thu được tạo bằng seedIncomeCategories.
    this.version(2).stores({
      incomes: 'id, date, categoryId, personId, updatedAt',
    });
  }
}

export const db = new FintoDB();

export const now = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
export const base = (): Base => {
  const t = now();
  return { id: uuid(), createdAt: t, updatedAt: t, deletedAt: null };
};
export const alive = <T extends Base>(r: T) => !r.deletedAt;
