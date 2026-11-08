# Hihand Finto

A personal expense manager for the web: split bills, track what people owe you, record what you give away, and keep money you hold for others. All data stays in the browser (IndexedDB). There is no server and no login.

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # money-calculation rule tests
npm run build    # PWA build in dist/
```

## Project structure

| Path | Contents |
| --- | --- |
| `src/db/schema.ts` | Tables (Dexie/IndexedDB): people, categories, tags, transactions, shares, settlements, allocations, incomes… |
| `src/db/seed.ts` | Default categories, subcategories and tags |
| `src/db/backup.ts` | JSON backup / restore |
| `src/domain/split.ts` | Equal split (RULE-03), split of the remainder, parsing shorthand like "360k" |
| `src/domain/ledger.ts` | Save expenses, auto-deduct from held money, record payments (partial payments), delete (RULE-13) |
| `src/domain/ledger.test.ts` | Tests for UC-01 → UC-04 |
| `src/domain/period.ts` | Monthly periods based on the month start day (RULE-11), dd/mm/yyyy date formatting |
| `src/domain/stats.ts` | Every derived number: period stats, outstanding receivables, held money, Given / Owed per person, search |
| `src/domain/catalog.ts` | Add / edit / soft-delete categories, subcategories, tags and people (BR-14) |
| `src/domain/stats.test.ts` | Tests for UC-05 → UC-08, edit / delete / undo, held money |
| `src/domain/monthEnd.ts` | Month-end surplus note when the app opens in a new period; days since last backup (NFR-04) |
| `src/domain/export.ts`, `src/lib/xlsx.ts` | Excel export (BR-19): Shares, Payments and Income sheets; the .xlsx is built by hand (only `fflate` is used for zipping) |
| `src/domain/phase3.test.ts` | Tests for yearly stats, groups, month-end notes, backup reminders, Excel export |
| `src/domain/income.ts` | Income (salary, bonus, gifts…), edit / delete / undo, opening balance |
| `src/domain/income.test.ts` | Tests for income, the "Left over" figure, balances, upgrading v1 data to v2 |
| `src/domain/held.test.ts` | Tests for the two balances and UC-09 → UC-13 (gift the overpayment, forgive the shortfall, hold money, pay on behalf, return held money) |
| `src/domain/review.test.ts` | Regression tests for issues found in the security / bug review |
| `src/domain/perf.test.ts` | Performance test with 10,000 transactions (NFR-01) |
| `src/ui/` | Shared components: icons, avatars, pills, toasts with undo, category/tag pickers, transaction rows, edit dialogs, income form, year chart |
| `src/pages/` | 7 screens: Overview, Add, Transactions, Collect, People, Stats, Settings |
| `src/index.css` | Midnight Lilac (dark) / Lavender Cloud (light) themes via CSS variables |

## Status

- **Phase 1 (foundation): done.** Themes, database, seed data, money logic with tests, backup/restore, PWA.
- **Phase 2 (MVP): done.** Add expense (equal or custom split, Owed / Given, auto-deduct from held money), Transactions (search, filter, split details, edit, delete with 10-second undo, duplicate), Overview, Collect (partial payments, prepayments, deduct from held money), People, monthly stats, settings for categories / tags / people / month start day, backup/restore. On mobile, a bottom nav with a "+" button.
- **Phase 3 (polish): done.** Yearly stats (12-month chart, monthly average, click a bar to open that month), frequent groups (picking a group pre-selects everyone in it), month-end notes like "An overpaid 60k (November)", Excel export per period, backup reminder after 7 days.
- **Income: done.** Income tab on the Add screen (separate income categories, optional giver such as Mom), opening balance, yearly Income vs Spending chart, a "Gave you" section on People, an Income sheet in Excel. Database schema v2 (old data upgrades automatically with no loss).
- **Held money & two balances: done.** *Account balance* (matches your bank) and *My balance* (= account − money held for others). When collecting, an overpayment can be kept as held money or accepted as a gift, and a shortfall can stay owed or be forgiven. Per-item Forgive button for receivables. "Pay on behalf" tab (deducted from held money), "Receive money to hold", "Return held money", a held-money ledger per person, and a Bills category.
- **"Left over"** = income − what I actually spent (Mine + Given + forgiven). It excludes advances and on-behalf payments covered by held money. "Advanced" is only the part of Owed not yet covered by held money.
- **Privacy mode:** every time the app opens, income, balances, "Left over" and income items show as •••••. Tap the eye button next to the app name to reveal them for that session. Auto-hide can be turned off in Settings › General. Spending is always visible.
- **Phase 4 (on hold):** mobile app (Capacitor) + web ↔ mobile sync via QR code.

## Security & privacy

- Data lives only in the browser's IndexedDB; the app makes no network calls. The Nunito font is self-hosted (`@fontsource/nunito`), not loaded from Google Fonts.
- The production build ships a Content-Security-Policy (`vite.config.ts`) that only allows the app's own scripts and assets.
- No `innerHTML` / `dangerouslySetInnerHTML`. Excel cells are written as inline strings (no formulas are evaluated) and all XML is escaped.
- Restoring a backup validates the file before any data is wiped; corrupt files or files with missing tables are rejected.
- Every write validates dates, amounts and categories, and each save runs in a single IndexedDB transaction.
- `npm audit`: the remaining warnings are in PWA build tooling (workbox-build, glob, minimatch) and do not ship in the browser app.
- `src/domain/perf.test.ts`: with 10,000 transactions, every calculation for a screen finishes in under 1 second (NFR-01).
