import { useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Icon, Modal } from './kit';
import { isTouch, local, useInstall } from './platform';

/** A new version is available: ask before reloading so unsaved input is not lost. Checks for updates every hour. */
export function UpdateBanner() {
  const { needRefresh: [need, setNeed], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      if (reg) setInterval(() => { void reg.update(); }, 60 * 60 * 1000);
    },
  });
  if (!need) return null;
  return (
    <div className="update-bar" role="status">
      <span className="grow">Có bản mới của Hihand Finto.</span>
      <button type="button" className="btn sm" onClick={() => setNeed(false)}>Để sau</button>
      <button type="button" className="btn sm primary" onClick={() => updateServiceWorker(true)}>Tải lại</button>
    </div>
  );
}

const DISMISS_KEY = 'finto.installDismissedAt';

/**
 * Prompt to install the app to the home screen (on phones, when opened in a browser tab).
 * On iOS, data of a site opened in a Safari tab may be deleted after a while without use; an installed app is not.
 */
export function InstallBanner() {
  const inst = useInstall();
  const [hidden, setHidden] = useState(() => Number(local.get(DISMISS_KEY) ?? 0) > Date.now() - 7 * 86_400_000);
  const [guide, setGuide] = useState(false);
  if (inst.installed || hidden || !isTouch() || (!inst.ios && !inst.canPrompt)) return null;
  const later = () => { local.set(DISMISS_KEY, String(Date.now())); setHidden(true); };
  return (
    <>
      <div className="banner" role="status">
        <span className="grow">
          <b>Cài Finto lên màn hình chính</b> để mở như app, dùng được khi không có mạng
          {inst.ios ? ' và để Safari không xóa dữ liệu của bạn.' : '.'}
        </span>
        <button type="button" className="btn sm" onClick={later}>Để sau</button>
        <button type="button" className="btn sm primary" onClick={() => (inst.canPrompt ? void inst.prompt() : setGuide(true))}>Cài app</button>
      </div>
      {guide && <InstallGuide onClose={() => setGuide(false)} />}
    </>
  );
}

/** Install guide for iPhone / iPad (iOS has no automatic install button). */
export function InstallGuide({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Cài Finto lên iPhone" onClose={onClose}>
      <img src="/brand-square.png" width={120} height={120} alt="Hihand Finto" style={{ borderRadius: 26, alignSelf: 'center' }} />
      <ol className="install-steps">
        <li>Mở trang này bằng <b>Safari</b> (finto.hihandlabs.online).</li>
        <li>Bấm nút <b>Chia sẻ</b> <span className="ios-share" aria-label="biểu tượng chia sẻ"><Icon name="share" size={16} /></span> ở thanh dưới (hoặc trên) của Safari.</li>
        <li>Kéo xuống, chọn <b>Thêm vào MH chính</b> (Add to Home Screen) → <b>Thêm</b>.</li>
        <li>Mở Finto từ biểu tượng mới trên màn hình chính.</li>
      </ol>
      <span className="small muted">
        Lưu ý: app trên màn hình chính có dữ liệu <b>riêng</b>, tách khỏi tab Safari. Nếu bạn đã nhập liệu trong tab Safari,
        hãy vào Cài đặt › Đồng bộ › <b>Hiện mã QR</b> ở tab Safari rồi <b>Quét mã QR</b> trong app đã cài (hoặc Sao lưu ở tab Safari rồi Khôi phục trong app).
      </span>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn primary" onClick={onClose}>Đã hiểu</button></div>
    </Modal>
  );
}
