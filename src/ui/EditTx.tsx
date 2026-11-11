import { useState } from 'react';
import { db, type Transaction } from '../db/schema';
import { updateTransactionMeta } from '../domain/ledger';
import { rootOf, type Index } from '../domain/stats';
import { Modal } from './kit';
import { money, useRun } from './format';
import { CategoryPicker, TagPicker } from './pickers';

/** RULE-09: only date, category, tags, note and product name can be edited. */
export default function EditTx({ ix, tx, onClose }: { ix: Index; tx: Transaction; onClose: () => void }) {
  const run = useRun();
  const cur = ix.category.get(tx.categoryId);
  const [date, setDate] = useState(tx.date);
  const [rootId, setRootId] = useState(rootOf(ix, tx.categoryId)?.id ?? '');
  const [subId, setSubId] = useState(cur?.parentId ? cur.id : '');
  const [tags, setTags] = useState<string[]>(ix.tagIdsOfTx.get(tx.id) ?? []);
  const [title, setTitle] = useState(tx.title);
  const [product, setProduct] = useState(tx.productName ?? '');

  const save = async () => {
    const ok = await run(() => updateTransactionMeta(db, tx.id, { date, categoryId: subId || rootId, title, productName: product, tagIds: tags }), 'Đã lưu thay đổi');
    if (ok !== undefined) onClose();
  };

  return (
    <Modal title="Sửa giao dịch" onClose={onClose}>
      <p className="small muted" style={{ margin: 0 }}>
        Số tiền {money(tx.totalAmount)} và người được chia không sửa được; nhầm thì xóa rồi tạo lại.
      </p>
      <div className="field"><label htmlFor="e-date">Ngày</label><input id="e-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <CategoryPicker ix={ix} rootId={rootId} subId={subId} onRoot={(id) => { setRootId(id); setSubId(''); }} onSub={setSubId} />
      <TagPicker ix={ix} rootId={rootId} value={tags} onChange={setTags} />
      <div className="field"><label htmlFor="e-title">Ghi chú</label><input id="e-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="field"><label htmlFor="e-prod">Tên sản phẩm</label><input id="e-prod" className="input" value={product} onChange={(e) => setProduct(e.target.value)} /></div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onClose}>Hủy</button>
        <button type="button" className="btn primary" onClick={save}>Lưu</button>
      </div>
    </Modal>
  );
}
