import { base, type FintoDB, type Category, type Tag, type CategoryTag } from './schema';

/** Danh mục, danh mục con và tag mặc định (theo mục "Dữ liệu mặc định" trong tài liệu). */
const DEFAULTS: { name: string; icon: string; countsAsMine?: boolean; children: string[]; tags: string[] }[] = [
  { name: 'Ăn uống', icon: 'utensils', children: ['Bữa chính', 'Cà phê & trà sữa', 'Ăn vặt', 'Lẩu/nướng/nhà hàng'], tags: ['đi chơi', 'bạn bè', 'người yêu', 'gia đình', 'ăn hằng ngày'] },
  { name: 'Di chuyển', icon: 'bike', children: ['Xăng', 'Grab/taxi', 'Gửi xe', 'Sửa xe'], tags: ['đi chơi', 'đi làm'] },
  { name: 'Mỹ phẩm', icon: 'sparkles', children: ['Sữa rửa mặt', 'Kem chống nắng', 'Son', 'Dưỡng da'], tags: ['quà'] },
  { name: 'Mua sắm', icon: 'bag', children: ['Quần áo', 'Đồ gia dụng', 'Đồ điện tử', 'Mua online'], tags: ['người yêu', 'quà'] },
  { name: 'Giải trí', icon: 'film', children: ['Phim', 'Game', 'Du lịch'], tags: ['đi chơi', 'bạn bè', 'người yêu'] },
  { name: 'Quà tặng', icon: 'gift', children: ['Sinh nhật', 'Lễ tết'], tags: ['bạn bè', 'người yêu', 'gia đình'] },
  { name: 'Chuyển tiền', icon: 'send', countsAsMine: false, children: ['Gia đình', 'Cho mượn'], tags: ['gia đình'] },
  { name: 'Khác', icon: 'dots', children: [], tags: [] },
];

export async function seedIfEmpty(db: FintoDB) {
  await seedExpense(db);
  await seedIncomeCategories(db);
  await seedBills(db);
}

/** Danh mục Hóa đơn (UC-12: trả hóa đơn hộ người khác), thêm một lần cho cả sổ cũ. */
export async function seedBills(db: FintoDB) {
  await db.transaction('rw', [db.settings, db.categories], async () => {
    const s = await db.settings.get('settings');
    if (!s || s.billsSeeded) return;
    const all = (await db.categories.toArray()).filter((c) => !c.deletedAt && c.kind !== 'income' && c.parentId === null);
    if (!all.some((c) => c.name === 'Hóa đơn')) {
      const parent: Category = { ...base(), name: 'Hóa đơn', icon: 'receipt', parentId: null, countsAsMine: true, sortOrder: all.length, kind: 'expense' };
      const kids = ['Điện', 'Nước', 'Internet', 'Điện thoại', 'Học phí'].map((n, j): Category => (
        { ...base(), name: n, icon: 'receipt', parentId: parent.id, countsAsMine: true, sortOrder: j, kind: 'expense' }));
      await db.categories.bulkAdd([parent, ...kids]);
    }
    await db.settings.update('settings', { billsSeeded: true });
  });
}

async function seedExpense(db: FintoDB) {
  await db.transaction('rw', [db.settings, db.categories, db.tags, db.categoryTags], async () => {
    const s = await db.settings.get('settings');
    if (s?.seeded) return;

    const tagByName = new Map<string, Tag>();
    const cats: Category[] = [];
    const links: CategoryTag[] = [];

    DEFAULTS.forEach((d, i) => {
      const parent: Category = { ...base(), name: d.name, icon: d.icon, parentId: null, countsAsMine: d.countsAsMine ?? true, sortOrder: i };
      cats.push(parent);
      d.children.forEach((c, j) =>
        cats.push({ ...base(), name: c, icon: d.icon, parentId: parent.id, countsAsMine: parent.countsAsMine, sortOrder: j }),
      );
      d.tags.forEach((t, k) => {
        if (!tagByName.has(t)) tagByName.set(t, { ...base(), name: t });
        links.push({ ...base(), categoryId: parent.id, tagId: tagByName.get(t)!.id, sortOrder: k });
      });
    });

    await db.categories.bulkAdd(cats);
    await db.tags.bulkAdd([...tagByName.values()]);
    await db.categoryTags.bulkAdd(links);
    await db.settings.put({
      id: 'settings', theme: s?.theme ?? 'dark', monthStartDay: 1, monthEndNote: true, autoApplyCredit: true, seeded: true,
    });
  });
}

/** Danh mục thu mặc định. */
const INCOME_DEFAULTS: { name: string; icon: string; children: string[] }[] = [
  { name: 'Lương', icon: 'wallet', children: [] },
  { name: 'Thưởng', icon: 'sparkles', children: ['Tết', 'KPI', 'Tháng 13'] },
  { name: 'Được cho/tặng', icon: 'gift', children: ['Gia đình', 'Bạn bè'] },
  { name: 'Thu nhập phụ', icon: 'bag', children: ['Freelance', 'Bán đồ'] },
  { name: 'Lãi/đầu tư', icon: 'chart', children: [] },
  { name: 'Khác', icon: 'dots', children: [] },
];

/** Tạo danh mục thu một lần (cả cho sổ mới lẫn sổ cũ nâng cấp từ bản không có thu nhập). */
export async function seedIncomeCategories(db: FintoDB) {
  await db.transaction('rw', [db.settings, db.categories], async () => {
    const s = await db.settings.get('settings');
    if (!s || s.incomeSeeded) return;
    const cats: Category[] = [];
    INCOME_DEFAULTS.forEach((d, i) => {
      const parent: Category = { ...base(), name: d.name, icon: d.icon, parentId: null, countsAsMine: false, sortOrder: i, kind: 'income' };
      cats.push(parent);
      d.children.forEach((c, j) => cats.push({ ...base(), name: c, icon: d.icon, parentId: parent.id, countsAsMine: false, sortOrder: j, kind: 'income' }));
    });
    await db.categories.bulkAdd(cats);
    await db.settings.update('settings', { incomeSeeded: true });
  });
}
