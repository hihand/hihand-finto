# Mobile test checklist (Phase 4 — PWA)

Main device: **iPhone 12 Pro (Safari)**. Add an Android phone (Chrome) if available.
Site: https://finto.hihandlabs.online — deploy the new build to Vercel before testing.
Labels in quotes are the Vietnamese UI texts to look for.

> Important on iPhone: an app added to the home screen has its **own data**, separate from the Safari tab.
> If you already entered data in a Safari tab: Cài đặt › Chung & dữ liệu › **Sao lưu** (in the Safari tab) → open the installed app → **Khôi phục từ file**.

## A. Install
1. Open the site in Safari → Overview shows the “Cài Finto lên màn hình chính” card → tap **Cài app** → the install guide appears.
2. Safari › Share › **Thêm vào MH chính** (Add to Home Screen) → the Finto icon (purple wallet, purple background, no black corners) appears, named “Finto”.
3. Open it from the home screen: a dark purple splash screen, **no** Safari address bar.
4. Top of the screen: time / battery readable, the “Hihand Finto” header is not covered by the notch. Switch to the light theme: the top band is purple and the time is still readable.
5. Bottom: the tab bar is not covered by the home indicator; the “+” button is tappable.
6. Cài đặt › Chung & dữ liệu: the “Ứng dụng” row says it is opened from the home screen; the “Lưu trữ trên máy này” row says whether storage is persistent and how much is used.

## B. Data entry
7. Tap “+” → focusing the amount field does **not** zoom the page; the number keypad opens; type “1,5” then tap the **tr** button under the field → shows “= 1.500.000đ” (the **000** and **k** buttons work the same).
8. Scroll to the bottom of the Add expense screen: the **Lưu** (Save) button stays at the bottom (above the tab bar).
9. Mọi người › + Số đầu kỳ → the dialog slides up from the bottom; tap the “Tôi đang nợ…” field → the keyboard does **not** cover the field or the Save button (the dialog scrolls).
10. Pay 18M on behalf of Mẹ (while owing her 12M) → the “Khoản này xử lý thế nào?” box shows: offset 12M, Mẹ owes back 6M.
11. Tap buttons / list rows: no color stays “stuck” after tapping.

## C. Files
12. Cài đặt › Chung & dữ liệu › **Sao lưu (JSON)** → the iOS share sheet opens → **Save to Files** (iCloud Drive). If only a “File đã sẵn sàng” toast appears → tap **Chia sẻ file**.
13. Excel export (Giao dịch › Xuất Excel) → opens in Numbers / Excel from the share sheet.
14. **Khôi phục từ file** → pick the backup just saved in Files → data is back as before.

## D. Offline + updates
15. Turn on Airplane mode → open the app from the home screen → it still opens and an expense can be added.
16. Deploy a new build to Vercel → open the app (online) → within a few minutes “Có bản mới của Hihand Finto” appears → tap **Tải lại** → the app reloads, data intact.
17. Privacy: tap the eye to show amounts → go to the home screen for more than 1 minute → reopen → amounts are hidden again (•••••).
18. Leave data unbacked-up for more than 3 days → Overview shows the backup reminder.

## E. Android (Chrome) — if available
19. Open the site → the “Cài Finto” card → **Cài app** shows Chrome's install dialog (no guide needed).
20. The icon follows the launcher shape (round / rounded), the logo is not clipped.
21. Repeat steps 7–9, 12 and 15.

Note which steps fail (with screenshots) so they can be fixed.
