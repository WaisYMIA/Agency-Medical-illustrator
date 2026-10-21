# Medical Premium Illustrator — Backend

This is the private half of the system. It has two jobs:

1. Hold every rate table (`data.json`) and pricing formula (`engine.js`)
   for JCare, J-Junior, and JSenior. **None of this is ever sent to the
   browser.** The frontend only ever receives the final computed premium
   numbers, via:

   ```
   POST /api/calculate
   Body: { "product": "JCARE" | "JUNIOR" | "JSENIOR", "input": { ... } }
   Returns: { "results": [ ... one entry per plan tier ... ] }
   ```

2. Gate access behind an agent acknowledgement: OTP-verify each agent's
   phone number, and keep a server-side audit trail of their Terms of Use
   acceptance. See "Agent verification & terms acceptance" below.

3. **Serve the frontend itself** (single-host mode — see the top-level
   `README.md`). `server.js` includes
   `app.use(express.static(path.join(__dirname, '../frontend')))`, so as
   long as `frontend/` sits alongside `backend/` (exactly as they do in
   this repo), this one Node process is the entire deployable app —
   frontend and API together, one URL, no CORS to configure. This is the
   recommended way to run this project now; it works on any host that
   runs Node, not just Render.

## Requirements

**Node.js 22.13 or newer.** The database uses Node's built-in SQLite
(`node:sqlite`), which doesn't exist in older versions. On **Render**,
**Railway** and similar hosts the Node version is read from
`package.json`'s `engines` field (and the `.node-version` file included
here), both already set — but if a deploy fails at startup with "No such
built-in module: node:sqlite", set the Node version to 22 in the host's
settings. Locally, check with `node --version`.

## Where this can run

This is a plain Node/Express app — it runs anywhere Node does: Render,
Railway, Fly.io, DigitalOcean, AWS/GCP/Azure, or a bare VPS with `node
server.js` behind nginx and a process manager (pm2, systemd). None of the
instructions below are GitHub-specific; **Render** is used here purely
because it has a workable free tier and deploys straight from a GitHub
repo, which is convenient if that's where your code already lives. If
you're using split hosting (see the top-level README's "Option B"),
GitHub Pages specifically can't run this backend, since it only serves
static files — but that only matters for Option B, not for single-host
deployment to any other Node host.

## Environment variables (set these before any real deployment)

| Variable | Required? | Purpose |
|---|---|---|
| `PORT` | No | Set automatically by most hosts (Render, Railway, etc.) — only set manually for a bare VPS. |
| `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD` | **Yes, once, on first start** | Creates your first personal admin account the first time the server starts with none. Ignored once any admin exists, so leaving them set is harmless — but you can remove them afterwards. Password must be 8+ characters. See "Admin accounts" below. |
| `ADMIN_SECRET` | Recommended until you have an account | The **legacy** shared secret. Still accepted as a fallback so nothing breaks, but actions taken with it are logged as `legacy-secret`, not under a person's name. Defaults to `dev-only-change-me` — **change it** (or rely on real accounts and treat this as break-glass only). The server warns at startup if it's still the default. |
| `SMS_PROVIDER_CONFIGURED` | No (stays in dev mode until set) | Set to `true` once you've implemented real SMS sending in `sms.js`. Until then, OTPs are only logged to this server's own console. |
| `ALLOWED_ORIGIN` | No | Restricts which origin may call the API from a browser. Unset allows any. Irrelevant for the public app in single-host mode (same-origin). **Caveat:** the admin pages are opened as local files, which browsers treat as having no origin — setting this will make them fail with CORS errors. Admin endpoints are protected by sign-in regardless, so leaving it unset is fine; only set it if you host the frontend separately and don't use the admin pages from a local file. |
| `ERROR_WEBHOOK_URL` | No | If set, unexpected server errors are POSTed here (Slack/Discord incoming-webhook URLs work as-is). See "Monitoring" below. |
| `LOG_REQUESTS` | No | Set to `false` to switch off per-request log lines. |
| `DB_PATH` | **Yes, if your host's disk is ephemeral** | Where the SQLite database file lives. Defaults to `backend/data.db`. On a host with a persistent disk/volume, point this at that volume (e.g. `/var/data/data.db`) or the database is lost on restart — see "The database" below. Also used by the test suite (fresh temp file per run). |
| Whatever your SMS provider needs (e.g. `AT_API_KEY`, `AT_USERNAME` for Africa's Talking) | Only once `SMS_PROVIDER_CONFIGURED=true` | See `sms.js` for the exact variables your chosen provider expects. |

## Deploying to Render (free tier)

1. Push this `backend/` folder to a GitHub repository (it can be the same
   repo as the frontend, in its own folder, or a separate repo — either
   works).
2. Go to [render.com](https://render.com) and sign up / log in (you can
   sign in directly with your GitHub account).
3. Click **New → Web Service**.
4. Connect your GitHub repository.
5. If backend and frontend share one repo, set **Root Directory** to
   `backend`.
6. Configure:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
7. Click **Create Web Service**. Render will install dependencies, start
   the server, and give you a live URL that looks like:

   ```
   https://medical-premium-illustrator-api.onrender.com
   ```

   **In single-host mode, this URL IS your whole app** — open it
   directly and it serves the frontend too, no separate deployment step.
   (In split mode, this is just the API, and you'd still deploy
   `frontend/` separately per the top-level README's Option B.)

8. Copy that URL — you'll paste it into `frontend/config.js` as
   `API_BASE_URL` before deploying the frontend.

### A note on the free tier

Render's free web services "sleep" after periods of inactivity and take
10–30 seconds to wake up on the next request. The very first calculation
(or OTP request) after a quiet spell may feel slow; after that it responds
quickly until it goes idle again. If that delay is a problem for
client-facing use, Render's paid tier (or an alternative like Railway)
removes it.

## Agent verification & terms acceptance

Before an agent can generate an illustration, the frontend requires:

1. **Terms acceptance** — name entered, checkbox ticked, recorded against
   a version string (`TERMS_VERSION` in `frontend/app.js`).
2. **Phone OTP verification** — a 6-digit code sent to the agent's phone,
   verified server-side.

Both are recorded server-side (not just in the browser) via:

```
POST /api/agent/request-otp   { phone }
POST /api/agent/verify-otp    { phone, otp, agentName }
POST /api/agent/accept-terms  { agentToken, phone, agentName, termsVersion }
GET  /api/agent/session?agentToken=...
```

Once verified, the frontend stores a session locally (`localStorage`) so
the agent isn't asked again on that device — but the *authoritative*
record is the one written here on the server, in the database — and the
server checks it on every calculation request, so a saved browser session
alone gets nobody in.

### Setting up real SMS delivery

As shipped, **no SMS is actually sent** — `sms.js` logs the OTP to the
server's own console instead, so the feature is fully testable without a
paid account. To send real texts:

1. Sign up with an SMS provider. **Africa's Talking** is a common choice
   for Kenyan numbers and has a free sandbox for testing.
2. Implement `sendSmsLive()` in `sms.js` using that provider's SDK/API.
3. Set the environment variable `SMS_PROVIDER_CONFIGURED=true` on Render
   (Environment tab) — until this is set, the module deliberately stays
   in safe dev mode, so nothing can silently half-work in production.
4. Add whatever API key/secret environment variables your provider needs
   (also under Render's Environment tab — never commit these to git).

### Branding admin (Phase 1 — see ROADMAP.md)

`PUT /api/branding` (used by `admin/branding.html` to change company
name, product name, colors, and contact details) requires an admin
sign-in — a personal account (see "Admin accounts" below) or, as a
fallback, the legacy `ADMIN_SECRET`. Branding changes are recorded in
the audit log under the admin's name.

### The database

All persistent data — agent verification records, terms acceptances,
branding config, and imported rate schemas — lives in a **real SQLite
database**, managed by `db.js`. This replaced the earlier JSON-file
storage.

It uses Node's **built-in** SQLite (`node:sqlite`), so there is nothing
to install and no separate database server to run or configure. The
entire database is a single file (`backend/data.db` by default; override
with the `DB_PATH` environment variable).

**Backing it up:** copy that one file. For a guaranteed-consistent copy,
stop the service first, then copy `data.db` along with any `data.db-wal`
and `data.db-shm` files sitting beside it. There's an automated test
(`test/db.test.js`) that specifically verifies a plain file copy works
as a restorable backup.

**One important caveat — a database does not make a disk persistent.**
If you deploy to a host with an *ephemeral* filesystem (notably
**Render's free tier**), the database file itself will still be wiped on
restart or redeploy, exactly like the old JSON files were. SQLite fixes
data integrity and querying, not where the disk lives. So for anything
carrying real agent records:

- **Local server:** nothing to do — the disk persists normally.
- **Render:** attach a **persistent disk** (a paid add-on) and set
  `DB_PATH` to a path on that disk, e.g.
  `DB_PATH=/var/data/data.db`.
- **Railway / Fly.io / DigitalOcean / VPS:** attach a volume (or just
  use the normal filesystem on a VPS) and point `DB_PATH` at it.

This matters specifically because the terms-acceptance audit trail is
what Section 2/3 of `TERMS.md` relies on — losing it would undermine the
whole agent-accountability mechanism.

**A note on `node:sqlite` being experimental:** Node currently prints an
`ExperimentalWarning` for this module on startup. It's tested and works
correctly here, and was chosen deliberately for needing zero
dependencies. If a future Node version changes it, `db.js` is the only
file that would need updating — every other module talks to
`store.js` / `branding-store.js` / `products-store.js`'s plain
functions, never to SQLite directly.

### Security hardening (Phase 4)

`security.js` provides three things that were previously missing:

**Security headers** on every response — `X-Content-Type-Options`,
`X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and a
Content Security Policy. HSTS is added only when the request arrived
over HTTPS (setting it on plain local HTTP would be wrong).

*Known CSP limitation:* the policy has to allow `'unsafe-inline'` for
scripts and styles, because the frontend and admin pages deliberately
use inline blocks — the whole project is built to run with no build
step. Tightening this means extracting every inline block to its own
file; noted as future work in `ROADMAP.md`.

**Rate limiting beyond OTP.** Previously only OTP requests were
throttled; `/api/calculate` and every admin endpoint were wide open.
Now: 120 requests/min per IP generally, 60/min for calculations, 30/min
for admin endpoints. Respects `x-forwarded-for`, so it works correctly
behind a proxy or load balancer.

*Known limitation:* the counters live in process memory. On a
single-instance deployment (what this project targets) that's correct.
Running multiple instances behind a load balancer would mean each keeps
its own counts, so effective limits multiply — that would need a
shared store.

**Hardened admin authentication.** The secret is now compared in
constant time (`crypto.timingSafeEqual`), so the comparison can't leak
the secret through response timing. Ten failed attempts from one IP
within 15 minutes locks that IP out for 15 minutes — and the lockout is
per-IP, so an attacker can't lock out a legitimate admin.

The server also prints a startup warning if `ADMIN_SECRET` is still the
built-in default, because that's easy to miss in documentation.

**Still a real gap:** every admin has full access — there's authentication
(who you are) but not authorization (what you may do). See "Admin
accounts" above.

### Agent management (Phase 4)

`admin/agents.html` lists every verified agent with their phone number,
when they first verified, when they were last active, and how many times
they've accepted the Terms. You can expand any agent to see their full
acceptance history, and revoke access.

**Revoking takes effect on the agent's very next request.** This is
enforced by the server, not just the browser: `/api/calculate` requires an
`X-Agent-Token` header that resolves to a currently-verified agent, so a
revoked agent's next attempt is refused and the app sends them back to the
terms + OTP gate (with the Terms box unticked, so acceptance is a fresh
act). *An earlier version of these docs claimed this when it wasn't true:
the gate lived only in the browser, nothing re-checked a saved session,
and the API accepted anyone. That's fixed, and tests in `api.test.js` and
`frontend-flow.test.js` now pin the behaviour down.*

**Revoking keeps the audit trail.** Revoking deletes the agent record,
but deliberately does *not* delete their record of
having accepted the Terms. Revoking access and erasing the evidence that
someone accepted responsibility are very different things — and Sections
2/3 of `TERMS.md` depend on that history surviving. There's a test
specifically asserting this.

Endpoints: `GET /api/agents`, `POST /api/agents/revoke`, and
`GET /api/agent/acceptances?phone=...` — all admin-protected.

### Admin accounts (Phase 4)

Admin access used to be one shared secret with no record of who did
anything. There are now **personal accounts**: username + password
(hashed with scrypt, per-account salt), a session token that expires
after 24 hours, and an **audit log** of who did what.

**Creating your first account:** set `ADMIN_BOOTSTRAP_USERNAME` and
`ADMIN_BOOTSTRAP_PASSWORD` and start (or restart) the server. It creates
the account once, and only if no admin exists yet — a leftover variable
can never add a second admin later.

**Adding someone, resetting a forgotten password, removing someone who
has left** — run these *on the server*, against the same database as the
running app (same `DB_PATH` if you set one):

```bash
node admin-cli.js list
node admin-cli.js create <username>          # asks for a password
node admin-cli.js set-password <username>    # also signs them out everywhere
node admin-cli.js remove <username>          # refuses to remove the last admin
```

The password is typed at a hidden prompt or read from
`ADMIN_CLI_PASSWORD` — never taken as an argument, where it would land in
shell history. Having access to the server is the deliberate proof of
identity for these operations.

**The audit log** records branding changes, product drafts and
publishes, agent revocations, and sign-ins (including failed ones), each
with the admin's name and IP. View it in `admin/analytics.html`. Anything
done with the legacy `ADMIN_SECRET` is attributed as `legacy-secret`,
because there's no way to know which person it was. A removed admin's
past actions stay in the log.

**What this is not:** real *authorization*. Every admin can do
everything. A hierarchy (platform admin vs. company admin) only becomes
meaningful once multiple companies exist (Phase 3) — see `ROADMAP.md`.
The `role` column is there so that can be added without migrating data.

### Usage analytics (Phase 4)

`admin/analytics.html` shows illustrations generated by product, plan
tier, agent and day (East Africa Time). **No client information is
recorded** — an event holds only the product, tier, verified agent and
timestamp, consistent with the commitment in `TERMS.md`. A test asserts a
client's name never reaches the table, and another pins the table's
columns so nobody can quietly add one. Each click of *Generate* counts
once, so this measures usage, not number of distinct clients (which, by
design, isn't knowable). Past illustrations stay attributed to an agent
after they're revoked.

### Monitoring (Phase 4)

- **Structured logs** — one JSON object per line (time, level, message,
  …), which hosts like Render and Railway can search and filter. Request
  logs record method, path, status and duration only.
- **Never logged:** request bodies (client ages and family details),
  query strings (agent phone numbers), headers (session tokens, the admin
  secret) or IP addresses. This is tested.
- **Safe errors** — an unexpected failure returns a generic
  500 to the caller (nothing about the internals leaks) and the real error
  goes to the log. An uncaught exception is logged and the process exits
  so the host restarts a clean one.
- **Alerts** — set `ERROR_WEBHOOK_URL` and unexpected errors are POSTed
  there (Slack and Discord webhook URLs work directly). Identical errors
  are collapsed and the total is capped at 5 a minute, so a failure loop
  can't flood the channel; a dead webhook can never cause further errors.
- **Health check** — `GET /api/health` returns 200 only if the database
  is actually reachable, and 503 otherwise. Point an uptime monitor
  (UptimeRobot, Render's health checks) at it.

*This is a webhook, not Sentry.* Sentry needs an account and its SDK; if
you adopt it later, `reportError()` in `logger.js` is the one place to
hook it in.

### A note on rate limiting

`store.js` limits OTP requests to 3 per phone number per 15-minute window,
and OTPs are single-use, expire after 5 minutes, and lock out after 5
incorrect attempts. This protects against SMS-cost abuse and brute-forcing,
but it's an application-level control, not a substitute for the SMS
provider's own account-level safeguards — check those too once real SMS is
wired up.

## Running locally

```bash
npm install
npm start
```

The API will be available at `http://localhost:3001`. To watch OTPs in
dev mode, just look at this terminal's output after requesting one.

## Locking down access (optional, recommended once deployed)

By default `server.js` allows requests from any origin (`origin: '*'`) so
it's easy to get the split system working. Once you know your frontend's
final GitHub Pages URL, tighten this in `server.js`:

```js
app.use(cors({ origin: 'https://your-username.github.io' }));
```

This stops other websites from calling your calculation API — or your
agent OTP endpoints — directly.
