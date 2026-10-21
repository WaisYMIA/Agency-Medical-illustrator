# Medical Premium Illustrator — Product Roadmap

This document tracks the long-term direction for turning the Medical
Premium Illustrator from a single-agent tool into a platform other
insurance companies could run their own branded version of. It exists so
that decisions and progress aren't only remembered inside a chat
conversation — read this first before picking up work on the platform
vision.

**Scope decision (confirmed):** targeting the **Kenyan market only**.
Compliance references (Insurance Regulatory Authority, Kenya Data
Protection Act 2019) stay fixed to Kenyan law across all tenants — no
per-country legal configurability is being built. This removed a
meaningful chunk of complexity from the original proposal below.

## The vision, in one paragraph

Multiple insurance companies each run their own branded instance (own
name, colors, logo, product names) of the same underlying illustrator
engine. Each company's admin can upload their own rate workbooks and, via
a guided (human-reviewed, not fully automatic) import process, get their
product's rates live on the platform — without needing custom code
written for them.

## Phases

### Phase 0 — Foundation (current single-tenant system)
**Status: done.** JCare / J-Junior / JSenior calculators,
frontend/backend architecture (rates never reach the browser), agent OTP
verification + Terms acceptance gate. Deployable single-host (one Node
service serves both, recommended — see "Deployment Flexibility" below)
or split (frontend on GitHub Pages, backend on Render). This is the
system in production use today.

### Phase 1 — Branding / white-label layer
**Status: prototype in progress (this phase).**

Goal: prove that company name, product name, brand colors, and contact
details can be externalized from hardcoded values into a config that's
fetched at runtime — without touching the calculation engine at all.

What this phase deliberately does NOT yet include (that's Phase 2+):
- (Originally listed here: "a real database". This has since been done —
  see "Database" below. Branding now lives in SQLite, not a JSON file.)
- Real admin authentication (a shared secret only, as a placeholder)
- Multiple tenants existing at once (this prototype has one branding
  config, not one per company)
- Logo image upload/hosting (text-based logo mark only, for now)

What it proves: the rest of the app (masthead, footer, page title, CSS
theme) can pull from a `/api/branding` config instead of literal strings,
and an admin screen can edit and publish that config live. This is the
architectural seam Phase 3 (true multi-tenancy) will build on — instead
of one branding config, there will be one per company, selected by which
company's link the agent opened.

### Phase 2 — Guided rate import
**Status: working prototype, proven end-to-end.**

Goal: let a company admin upload their own rate workbook and get a
reviewed, validated rate set live — without an engineer manually reading
Excel formulas (which is how JCare/J-Junior/JSenior were done).

**What actually works, tested against real HTTP calls to the real
backend, not just designed on paper:**

- **A generalized rate schema** (`backend/schemas/*.schema.json`) — a
  JSON shape that can describe tiers, per-role age-banded rates, flat
  rates, optional riders, and per-benefit eligibility (which roles get
  which benefit) — without writing new calculation code per product.
- **A generic engine** (`backend/generic-engine.js`) that computes
  premiums from that schema. This was the real technical risk in the
  whole idea, so it was tested hard: JCare, J-Junior, and JSenior were
  each re-expressed as a schema and run through the generic engine
  against 20+ scenarios (including every edge case previously found —
  shared-family-limit eligibility, family-size-unsupported combos,
  selective co-payment loading, spouse-only benefits, age boundaries).
  Every scenario matched the original hand-written engine exactly. That
  equivalence is the proof this approach holds up, not just an
  assertion that it should.
- **A guided mapping UI** (`admin/rate-import.html`) — upload a
  workbook (parsed in-browser via SheetJS), see the raw grid for
  reference, and type in which cell ranges map to which schema fields
  (tiers, each benefit's rates, age bands). The tool extracts and shows
  you the values it read before you save anything — you're confirming
  what a human decided the cells mean, not trusting an algorithm's
  guess.
- **Draft → preview → publish workflow**, backed by real endpoints
  (`backend/products-store.js` + routes in `server.js`): a draft schema
  can be previewed against a sample scenario before it's live, and
  JCare/J-Junior/JSenior can never be accidentally overwritten by this
  path — they stay hardcoded and are never looked up as a generic
  schema. Proven end-to-end with a fabricated "new company" workbook,
  all the way through to a live `/api/calculate` call returning the
  correct number.

**What's still a real gap, not yet built:**

- The mapping UI only covers two rate patterns in its form (flat-per-tier
  and age-banded-per-role) — it doesn't yet expose the "shared family
  limit"-style pattern or covid-style "options" pattern in the wizard,
  even though the underlying schema/engine support them (as proven by
  the JCare equivalence tests). A product needing those today would
  need its schema JSON hand-edited rather than built through the UI.
- No automatic table detection — the admin must know which cell range
  holds what. A drag-select spreadsheet UI would be a nicer version of
  this, not yet built.
- Validation is structural only (right number of tiers, right array
  lengths, tiers in ascending limit order) — it cannot tell you the
  *rates themselves* are correct. The preview step is what catches
  that, and still requires a human to actually check the numbers
  against the source workbook.
- Drafts and published schemas now live in a real SQLite database
  (see "Database" below), not a JSON file. Note the remaining caveat
  there: a database still needs a persistent disk underneath it on
  hosts whose filesystem is ephemeral.

### Phase 3 — True multi-tenancy (not started)
- Real database (Postgres), `Company → Product → RateVersion` hierarchy
- One branding config per company (extends Phase 1's single config)
- Custom subdomain/domain per company
- Rate version history — a policy illustrated in March must still be
  reproducible even if rates changed in June

### Phase 4 — Admin platform maturity (done, with one deliberate exception)

- **Security hardening — done.** Security headers (CSP, framing/sniffing
  protection, HSTS over HTTPS), rate limiting on every endpoint (not just
  OTP), timing-safe secret comparison and per-IP brute-force lockout
  (`backend/security.js`). Documented limitations rather than hidden
  ones: the CSP must allow `'unsafe-inline'` (the project deliberately has
  no build step), and rate-limit counters are per-process (right for one
  instance, would need a shared store for several).
- **Server-side agent enforcement — done, and it was a real hole.** While
  building analytics it became clear the agent gate (Terms + OTP) existed
  only in the browser: the API never checked it, so anyone could call
  `/api/calculate` directly, and **revoking an agent did nothing** — an
  earlier version of this document and the agent-management UI claimed it
  did. `/api/calculate` now requires an `X-Agent-Token` that resolves to a
  currently-verified agent; the app validates a saved session on startup,
  returns revoked agents to the gate mid-session, and leaves the Terms box
  unticked so each acceptance is a fresh act. Covered by `api.test.js`
  and `frontend-flow.test.js`.
- **Real admin accounts — done (authentication).** Personal usernames and
  passwords (scrypt, per-account salt), 24-hour sessions, an **audit log**
  of who did what, and `admin-cli.js` for adding admins, resetting
  passwords (which signs the admin out everywhere) and removing leavers.
  The legacy shared `ADMIN_SECRET` still works, logged as `legacy-secret`.
- **Agent management UI — done.** `admin/agents.html`. Revocation keeps
  the acceptance audit trail.
- **Usage analytics — done.** `admin/analytics.html`: illustrations by
  product, tier, agent and day (East Africa Time), plus the audit log.
  Stores no client data — enforced by tests, including one that pins the
  table's columns.
- **Monitoring — done, as a webhook.** Structured JSON logs, request
  logging that never records bodies/queries/headers/IPs, safe generic
  500s, a health check that verifies the database, and optional alerting
  to Slack/Discord/any webhook (`ERROR_WEBHOOK_URL`). **Not Sentry** —
  that needs an account and SDK; `reportError()` in `backend/logger.js` is
  the one place to hook it in later.
- **Deployment fix found along the way.** The database needs Node
  **22.13+**, but `engines` said `>=18` and CI ran Node 20 — so a host
  could have picked a Node that crashes at startup, and CI had been
  failing since the SQLite migration. Corrected, with a plain-English
  startup error if it ever happens.

**Deliberately not done: role-based *authorization*.** Admins are
authenticated individually, but every admin can do everything. A
hierarchy (platform admin vs. company admin vs. agent) only means
something once several companies exist — "which company may this admin
administer" has no answer today — so it belongs to Phase 3. The `role`
column on `admin_users` is ready for it.

**Smaller gaps still open:** no admin UI for creating/removing admins
(CLI only, by design for now), no password-change screen, no two-factor
sign-in, and the analytics counts each *Generate* click, not distinct
clients (which isn't knowable by design).

## Database

**Status: done.** All persistent state — agent verification records,
terms acceptances, branding config, and imported rate schemas — moved
from hand-rolled JSON files to a **real SQLite database** (`backend/db.js`,
using Node's built-in `node:sqlite`, so there's nothing to install and
no separate database server to run).

Why this mattered: the JSON version risked a half-written file if a
process died mid-write, had no real querying, and was flagged
repeatedly throughout development as the thing most likely to cause an
actual incident.

What changed and what didn't:

- `store.js`, `branding-store.js`, and `products-store.js` kept their
  **exact public function signatures** — `server.js` and every existing
  test called them unchanged. Only the storage mechanism underneath
  was replaced.
- Six real tables (`agents`, `otps`, `otp_requests`, `acceptances`,
  `branding`, `products`) with proper indexes and constraints.
- The backend tests all passed against the real database, including the
  full HTTP integration suite.
- New `backend/test/db.test.js` specifically proves persistence by
  spawning **genuinely separate Node processes**: one writes, exits,
  and a fresh process reads the data back. It also verifies that a
  plain file copy works as a restorable backup.

**The remaining caveat, stated plainly:** a database engine does not
make an ephemeral disk persistent. On hosts like Render's free tier,
the database *file* is still wiped on restart — the fix is attaching a
persistent disk/volume and pointing `DB_PATH` at it. This is documented
in `backend/README.md` with per-host instructions. On a local server,
this is a non-issue.

## Automated Testing

**Status: a real, working suite — currently 200+ tests, all passing.**

Built on Node's own test runner (`node:test`), so nearly all of it needs no
installation. Run it with `cd backend && npm install && npm test` and
`cd admin && npm test`; CI (`.github/workflows/test.yml`, Node 22) runs
both on every push.

**Backend (`backend/test/`)**
- `engine.test.js`, `generic-engine.test.js` — the calculation engines, and
  the proof that the schema-driven engine matches the hand-written one
  across 20 scenarios. **If `generic-engine.test.js` fails, Phase 2 can't
  be trusted until it's fixed.**
- `store`, `branding-store`, `products-store`, `db` — storage logic, plus
  persistence proven by writing in one process and reading in another, and
  that a plain file copy is a working backup.
- `security.test.js`, `logger.test.js`, `analytics.test.js`,
  `admin-auth.test.js`, `admin-cli.test.js` — headers/rate limits/lockout;
  logging, the webhook (against a real local receiver) and what is never
  logged; usage analytics and its privacy guarantee; admin accounts; the
  command-line tool.
- `api.test.js` — real HTTP against the real server: the agent gate
  enforced server-side, revocation actually working, admin sign-in and
  attribution, analytics recording, health check, and a deliberately
  broken database producing a safe 500.
- `frontend-flow.test.js` — **the real `frontend/app.js` against the real
  server** under a minimal fake DOM: normal use, an agent revoked
  mid-session, startup validation of a saved session, and tolerance of a
  flaky connection.
- `admin-signin.test.js` — the real admin sign-in panel against the real
  server.

**Admin (`admin/test/`)** — cell-range parsing for the rate-import wizard,
and the sign-in logic shared by every admin page.

Every file runs with no dependencies except the ones that start the real
server (`api`, `frontend-flow`, `admin-signin`), which need `npm install`
for `express`.

**Where the DOM tests stop.** The fake DOM can verify logic and what's
sent to the API; it can't check layout, CSS, or real clicking in a
browser. A real browser tool (e.g. Playwright) is the sensible next step
for that, and isn't built.

**Isolation.** Storage reads its location from `DB_PATH`; every test uses
a fresh temporary database, so none touches real data or another test.
Tests that make many admin requests use distinct synthetic client IPs,
because rate limits and lockouts are deliberately per-IP.

## Deployment Flexibility

**Status: done.** The system was originally built assuming split hosting
(frontend on GitHub Pages, backend on Render) because that was the free,
zero-setup path. It's since been generalized:

- `backend/server.js` now serves the frontend's static files itself
  (`express.static`), so **one Node service is the entire deployable
  app** — no separate static host, no CORS configuration, no keeping
  two deployments in sync. This is now the recommended default (see the
  top-level README's "Option A").
- `frontend/config.js` auto-detects which mode it's in: served from the
  same origin as the API → uses relative paths (same-origin, single-host
  mode); opened as a local `file://` → falls back to
  `http://localhost:3001` for local testing; anything else → stays at
  whatever explicit URL you set (split mode, e.g. a separately hosted
  GitHub Pages frontend pointed at a Render backend).
- Split hosting still works and is documented as "Option B" — nothing
  about it changed or broke. Neither mode is GitHub-specific: the
  backend runs on any Node host (Render, Railway, Fly.io, a VPS,
  whatever), and split mode's frontend half can go on any static host
  (Netlify, Vercel, S3, etc.), not just GitHub Pages.
- Verified end-to-end: a real Express server (via a temporary test
  shim with genuine static-file-serving behavior, removed before
  packaging as usual — see the project's testing conventions) correctly
  served the frontend's actual files (`index.html`, `styles.css`,
  `app.js`, `config.js`) alongside the API, and a full agent-gate +
  JCare-calculation flow completed correctly when driven against that
  single origin. These are now permanent tests in
  `backend/test/api.test.js`, not just a one-off check.

### Phase 5 — Product experience polish (not started)
- Emailing/texting the illustration directly to the client (with its own
  consent capture, same pattern as the agent gate)
- PWA packaging (installable, phone-first)
- Needs-based nudges (e.g. a client approaching 65 gets nudged toward
  JSenior)

## Where to pick this up

- This repository's `README.md` still documents how to deploy the
  current (Phase 0) system as-is — that hasn't changed.
- Phase 1 prototype files: the branding fetch/apply logic lives directly
  in `frontend/app.js` (`loadBranding()` / `applyBranding()`),
  `backend/branding-store.js` and the `/api/branding` routes in
  `backend/server.js` hold the config, and `admin/branding.html` is the
  editor UI. See the "Phase 1" section of this document for what's real
  vs. placeholder.
- Phase 2 prototype files: `backend/schemas/*.schema.json` (JCare/
  J-Junior/JSenior re-expressed in the generic schema, used only for
  equivalence testing — the live app still uses the original hardcoded
  engine for these three), `backend/generic-engine.js` (the schema
  interpreter), `backend/products-store.js` + the `/api/products/*`
  routes in `server.js` (draft/preview/publish), and
  `admin/rate-import.html` + `admin/rate-import-core.js` +
  `admin/range-extract.js` (the guided mapping wizard). See the "Phase 2"
  section above for exactly what's covered and what still needs the
  wizard extended (shared-limit and options-style rate patterns) or
  hand-edited schema JSON in the meantime.
- Phase 4 files: `backend/security.js`, `backend/admin-auth.js` (+
  `admin-cli.js`), `backend/analytics.js`, `backend/logger.js`, the
  `requireAgent` / `requireAdmin` helpers and `/api/admin/*` routes in
  `backend/server.js`, and in `admin/`: `index.html`, `agents.html`,
  `analytics.html` and the shared `admin-session.js`. The agent gate's
  server-side half is `requireAgent` in `server.js`; its browser half is
  `validateSavedSession()` / `endSessionAndReturnToGate()` in
  `frontend/app.js`.
- **Next, in order:** Phase 3 (multi-tenancy — which is also what gives
  role-based authorization its meaning), then Phase 5 (PWA, emailing
  illustrations, needs-based nudges). Before either, the launch blockers
  in the hand-off notes are still non-engineering: legal review of
  `TERMS.md`, company authorisation, a real SMS provider, a real
  `ADMIN_SECRET` / admin account, and a persistent disk if the host's is
  ephemeral.
- When resuming Phase 2 or later, re-read this file first — it captures
  decisions (Kenya-only scope, guided-not-automatic import) that aren't
  otherwise written down anywhere else.
