import { useState } from 'react';
import { db } from '../db/schema';
import { addTagToCategory } from '../domain/catalog';
import type { Index } from '../domain/stats';
import { Icon } from './kit';
import { useRun } from './format';

export function CategoryPicker({ ix, rootId, subId, onRoot, onSub, income }: {
  ix: Index; rootId: string; subId: string; onRoot: (id: string) => void; onSub: (id: string) => void; income?: boolean;
}) {
  const roots = income ? ix.incomeRoots : ix.roots;
  const subs = ix.childrenOf.get(rootId) ?? [];
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="field">
        <span className="label" id="cat-label">Danh mục</span>
        <div className="chips" role="group" aria-labelledby="cat-label">
          {roots.map((c) => (
            <button type="button" key={c.id} className="chip" aria-pressed={c.id === rootId} onClick={() => onRoot(c.id)}>
              <Icon name={c.icon} size={16} />{c.name}
            </button>
          ))}
        </div>
      </div>
      {subs.length > 0 && (
        <div className="field">
          <span className="label" id="sub-label">Danh mục con</span>
          <div className="chips" role="group" aria-labelledby="sub-label">
            {subs.map((c) => (
              <button type="button" key={c.id} className="chip sm" aria-pressed={c.id === subId} onClick={() => onSub(c.id === subId ? '' : c.id)}>{c.name}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** BR-02: tags follow the selected top-level category, multi-select, add a tag while entering. */
export function TagPicker({ ix, rootId, value, onChange }: { ix: Index; rootId: string; value: string[]; onChange: (ids: string[]) => void }) {
  const run = useRun();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const own = ix.tagsOfCategory.get(rootId) ?? [];
  // Tags already attached but not in this category (when editing / changing category) are still shown so they can be removed.
  const extra = value.filter((id) => !own.some((t) => t.id === id)).flatMap((id) => (ix.tag.get(id) ? [ix.tag.get(id)!] : []));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const add = async () => {
    const id = await run(() => addTagToCategory(db, rootId, name));
    if (id) {
      onChange([...value, id]);
      setName('');
      setAdding(false);
    }
  };
  const rootName = ix.category.get(rootId)?.name;
  if (!rootId) return null;
  return (
    <div className="field">
      <span className="label" id="tag-label">Tag của {rootName} · chọn nhiều</span>
      <div className="chips" role="group" aria-labelledby="tag-label">
        {[...own, ...extra].map((t) => (
          <button type="button" key={t.id} className="chip sm tag" aria-pressed={value.includes(t.id)} onClick={() => toggle(t.id)}>#{t.name}</button>
        ))}
        {adding ? (
          <span className="row nowrap" style={{ gap: 6 }}>
            <label className="sr-only" htmlFor="new-tag">Tên tag mới</label>
            <input id="new-tag" className="input" style={{ height: 36, width: 150 }} autoFocus value={name} placeholder="tag mới"
              onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } if (e.key === 'Escape') setAdding(false); }} />
            <button type="button" className="btn sm primary" onClick={add}>Thêm</button>
          </span>
        ) : (
          <button type="button" className="chip sm add" onClick={() => setAdding(true)}>+ tag</button>
        )}
      </div>
    </div>
  );
}
