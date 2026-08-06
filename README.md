# BizBuySell deal-sourcing system

Finds businesses for sale that match a buy-box, contacts the broker on each one
asking for the CIM, and tracks every conversation through to a deal.

---

## Read this first

BizBuySell sits behind **Akamai Bot Manager**. Measured 6 August 2026 from a
residential connection whose ordinary Chrome renders the site perfectly:

| How we asked | Result |
|---|---|
| Plain HTTP request | `403 Access Denied` |
| Headless Chromium | `403 Access Denied` |
| Headless Chromium + stealth patches | `403 Access Denied` |
| Real Chrome, visible window, stealth | `403 Access Denied` |
| Real Chrome, warmed persistent profile | `403 Access Denied` |
| Firecrawl (its own proxy network) | homepage OK, **search and listing pages blocked** |

`Server: AkamaiGHost`. Reproduce it yourself with `npx tsx scripts/probe-stealth.ts`.

**No amount of code fixes this.** What fixes it is the network the request comes
from. So every byte this system reads goes through one swappable *transport*,
and everything else — filters, database, tracker, scheduler, dashboard — is
written against that interface and does not care which one is in use.

| Transport | Setup | Reads | Sends | Notes |
|---|---|---|---|---|
| `firecrawl` | none | partial | no | Default. Retry periodically — proxy pools change. |
| `local` | a trusted machine | yes | yes | **Most likely to work.** A real browser on a connection the site accepts. |
| `proxy` | proxy account | yes | yes | Playwright through residential proxies (~$5–15/GB). Runs unattended. |

Switch in Settings → Transport, then press **Test connection**.

---

## Safety

Sending is the only irreversible thing here, so it is guarded four ways:

- **Dry run is the default.** Runs read, extract, and prepare each message —
  filling the real form and stopping short of the button. Nothing sends until
  sending is armed in Settings *and* the run is started as live.
- **One message per listing, ever.** A unique constraint in the database, not a
  flag in code, so two runs racing each other still cannot double-send.
- **Daily cap and jittered pacing.** Configurable. 300 identical messages in ten
  minutes is how an account gets suspended.
- **Stop button**, and a full audit trail with a screenshot on every failure.

---

## Running it

```bash
npm install
npx playwright install chromium      # only needed for local/proxy transport
cp .env.example .env                 # set DATABASE_URL and FIRECRAWL_API_KEY
npx prisma migrate deploy
npm run build && npm start           # http://localhost:3000
```

```bash
npm run selftest    # 79 offline checks — no network, no database, no API key
npm run dev         # watch mode
```

## Deploying to Railway

1. New project → add **PostgreSQL**.
2. Deploy this repo. `railway.json` selects the Dockerfile, which is built on
   the official Playwright image so Chromium and its system libraries are
   already present.
3. Set variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `FIRECRAWL_API_KEY`
4. Migrations run automatically on deploy (`preDeployCommand`).

Health lives at `/api/health` and always returns 200 while the process can
serve, naming whatever is degraded — a healthcheck that 5xx's because one
variable is unset tells you nothing.

**Note:** Railway's IPs are datacentre ranges, which Akamai blocks hardest. Expect
to run the `local` transport elsewhere, or to configure proxies.

---

## Layout

```
src/lib/transport.ts    the three ways to reach the site; swap here
src/lib/search-url.ts   filters -> BizBuySell URLs; industry and state tables
src/lib/extract.ts      HTML -> listings; money parsing, auction detection
src/lib/outreach.ts     login, form fill, send, pacing
src/lib/runner.ts       discover then contact; resumable, stoppable
src/server.ts           API + dashboard
public/                 dashboard, no build step
scripts/probe-*.ts      the reconnaissance behind the table above
```

## What the client still needs to provide

1. BizBuySell login for the buyer account.
2. A decision on transport — a machine to run the browser on, or proxy budget.
3. Contact details for the form: full name, phone, email.
4. Run frequency, and who works the replies.

## Worth raising with them

Sending through the site's own form is very likely against its terms of use, and
the realistic cost is the buyer's account being suspended. The same outreach
sent from their own mailbox — to broker contacts this system already collects —
carries none of that risk, threads replies properly, and lets the tracker update
itself from the inbox.
