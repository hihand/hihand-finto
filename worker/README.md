# finto-sync — QR sync relay

A Cloudflare Worker + Durable Object that lets two Hihand Finto devices sync live after one scans the other's QR code.

- One **room** per QR code, implemented as a Durable Object. The room holds two WebSockets (host + guest) in memory and forwards binary frames between them.
- Every frame is **AES-GCM encrypted end to end** with a one-time key that exists only inside the QR code / link fragment (`#sync=…`). The room id is a SHA-256 hash of that key, so the relay never sees the key and cannot read ledger data.
- **Nothing is stored**: no KV, R2 or D1, no request logging. Durable Object storage holds only the room's expiry alarm.
- **Limits:**
  - 2 devices per room.
  - The host waits at most **5 minutes** for a scan.
  - A session lasts at most 15 minutes.
  - At most 64 MB relayed per room. A full 5-year ledger is about 1–6 MB compressed.
  - Only pages listed in `ALLOWED_ORIGINS` (plus `localhost`) can open a room.
- **Cost:** fits the Workers **Free** plan. It uses a SQLite-backed Durable Object and WebSocket hibernation, so a room that is waiting does not bill duration.

## Deploy (once)

Requirements: Node 20+, a Cloudflare account.

```bash
cd worker
npm install
npx wrangler login          # opens the browser, allow access to your Cloudflare account
npx wrangler deploy
```

`wrangler.toml` routes the Worker to **`finto-sync.hihandlabs.online`** as a Custom Domain. Cloudflare creates the DNS record and certificate automatically, but this only works if the `hihandlabs.online` zone is on Cloudflare in the same account.

- **If the domain's DNS is elsewhere:**
  1. Remove the `routes = …` line from `wrangler.toml` and deploy again.
  2. Use the `https://finto-sync.<your-subdomain>.workers.dev` URL that wrangler prints.
  3. In Vercel › Project › Settings › Environment Variables, add `VITE_SYNC_URL = wss://finto-sync.<your-subdomain>.workers.dev`, then redeploy the app. The app's Content-Security-Policy is built from the same variable.
- **Check:** `curl https://finto-sync.hihandlabs.online/` should print `finto-sync ok`.

## Allowed origins

`ALLOWED_ORIGINS` in `wrangler.toml` is a comma-separated list. Add Vercel preview URLs there if you want to test sync on previews, then run `npx wrangler deploy`:

```toml
ALLOWED_ORIGINS = "https://finto.hihandlabs.online,https://hihand-finto-git-main-yourteam.vercel.app"
```

`http://localhost:*` and `http://127.0.0.1:*` are always allowed, for development. An Origin check only stops other websites from using the relay from a browser. Data stays safe regardless, because it is encrypted end to end.

## Develop / test locally

```bash
npm run dev           # relay on ws://localhost:8787 — the app's `npm run dev` uses it automatically
npm run typecheck

# Integration test (rooms expire after 3 s in this mode):
npm run dev:test      # in one shell
npm test              # in another
```

To run the app against the deployed relay instead: `VITE_SYNC_URL=wss://finto-sync.hihandlabs.online npm run dev` (from the repo root).

## Protocol (relay side)

| | |
|---|---|
| `GET /` | Health check: `finto-sync ok` |
| `GET /room/<22-char id>?role=host\|guest` | WebSocket upgrade |

- **Binary frames** are forwarded to the other device unchanged.
- **Text `ping`** is answered with `pong` by the runtime, without waking the object.
- **Text frames from the relay:** `{"relay":"paired"}`, `{"relay":"left"}`, `{"relay":"error","code":"expired|busy|gone|too-large"}`.
- **Close codes:**

  | Code | Meaning |
  |---|---|
  | 4001 | The other device left |
  | 4002 | Room busy |
  | 4004 | No such room / expired |
  | 4008 | Expired |
  | 4009 | Too large |

The sync session itself (hello, packages, acknowledgements) is defined in the app: `src/domain/relay.ts`.
