import type { ImportReport } from '../domain/sync';

const TABLE_NAME: Record<string, string> = {
  transactions: 'giao dịch', shares: 'phần chia', incomes: 'thu nhập', settlements: 'lần nhận / trả lại', allocations: 'khoản trừ',
  people: 'người', categories: 'danh mục', tags: 'tag', payables: 'khoản nợ', repayments: 'lần trả nợ',
  categoryTags: 'tag của danh mục', transactionTags: 'tag của giao dịch', groups: 'nhóm', groupMembers: 'thành viên nhóm', monthNotes: 'ghi chú cuối tháng',
};

/** What a merge changed: new / updated / removed records, automatic fixes and warnings. */
export function SyncReport({ report, title, extra, onClose }: { report: ImportReport; title?: string; extra?: string; onClose?: () => void }) {
  const parts = Object.entries(report.perTable).map(([t, s]) => `${s!.added + s!.updated} ${TABLE_NAME[t] ?? t}`);
  return (
    <div className={`summary ${report.warnings.length ? 'warn' : 'ok'} stack tight`} aria-live="polite">
      <div className="row between">
        <span className="strong">{title ?? `Đã gộp gói từ ${report.from.name}`}</span>
        {onClose && <button type="button" className="btn sm" onClick={onClose}>Đóng</button>}
      </div>
      <span className="small">
        {report.added + report.updated + report.removed === 0 && !report.settingsUpdated ? 'Nhận: không có gì mới.'
          : `Nhận ${report.added} bản ghi mới, ${report.updated} cập nhật${report.removed ? `, ${report.removed} đã xóa hoặc gộp trùng` : ''}${parts.length ? ` (${parts.join(', ')})` : ''}${report.settingsUpdated ? ' · cập nhật cài đặt chung' : ''}.`}
        {report.skipped ? ` Bỏ qua ${report.skipped} bản đã có hoặc cũ hơn.` : ''}
      </span>
      {extra && <span className="small">{extra}</span>}
      {report.fixes.map((f) => <span className="small" key={f}>Đã tự sửa: {f}</span>)}
      {report.warnings.map((w) => <span className="small c-give" key={w}>Cần xem lại: {w}</span>)}
    </div>
  );
}
