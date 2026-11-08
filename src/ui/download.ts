import { db } from '../db/schema';
import { exportBackup } from '../db/backup';
import { today } from '../domain/period';

export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** BR-15 + NFR-04: tải file sao lưu và ghi lại thời điểm để nhắc lần sau. */
export async function downloadBackup() {
  await db.settings.update('settings', { lastBackupAt: new Date().toISOString() });
  saveBlob(await exportBackup(), `hihand-finto-${today()}.json`);
}
