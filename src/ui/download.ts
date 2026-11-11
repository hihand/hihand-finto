import { useCallback } from 'react';
import { db } from '../db/schema';
import { exportBackup } from '../db/backup';
import { today } from '../domain/period';
import { useToast } from './format';
import { downloadFile, saveOrShare } from './platform';

/** Download a file (desktop). Kept under the old name for existing callers. */
export const saveBlob = downloadFile;

/**
 * Save a file: phones open the share sheet (Files, iCloud, Drive, Zalo…), desktops download it.
 * If the browser requires a new tap (the file took a while to build), show a toast with a "Chia sẻ file" button.
 */
export function useSaveFile() {
  const toast = useToast();
  return useCallback(async (blob: Blob, name: string, done?: string) => {
    const r = await saveOrShare(blob, name);
    if (r === 'needs-tap') {
      toast({ text: 'File đã sẵn sàng', action: { label: 'Chia sẻ file', run: () => { void saveOrShare(blob, name); } } }, 20_000);
    } else if (r !== 'cancelled' && done) {
      toast({ text: done });
    }
    return r;
  }, [toast]);
}

/** BR-15 + NFR-04: build the backup file, save / share it, record the time for the next reminder. */
export function useBackup() {
  const save = useSaveFile();
  return useCallback(async () => {
    const blob = await exportBackup();
    const r = await save(blob, `hihand-finto-${today()}.json`, 'Đã tạo file sao lưu');
    if (r !== 'cancelled') await db.settings.update('settings', { lastBackupAt: new Date().toISOString() });
  }, [save]);
}
