# Medical Premium Illustrator

A medical insurance quotation tool covering three independent products —
**JCare** (family), **J-Junior** (children), and **JSenior** (ages 65–79).

This project is split into two parts so that the rate tables and pricing
formulas — the valuable, proprietary part — are never sent to anyone's
browser:

```
frontend/   The interface: HTML, CSS, and UI logic. No rates or pricing
            formulas live here — it only knows how to display a form and
            call the backend for numbers.

backend/    A private API holding every rate table and the full
            calculation engine. This is the only place your pricing data
            exists. It never ships to the browser.
```

**Important — what this split does and doesn't do:** anyone can still
view the frontend's HTML/CSS/JS (that's true of every website — it can't
be prevented). What this split actually protects is the thing that
matters: your rate tables and formulas. Those now live only on a server
you control, and the browser only ever receives the final computed
premium — never the underlying numbers that produced it.

## How it works

1. The first time anyone opens the app on a device, they must accept the
   Terms and Conditions and OTP-verify their phone number (see "Agent
   gate" below). This happens once per device.
2. The frontend collects client details and cover selections, same as
   before — no change to how you use it.
3. When you click **Generate Illustration**, the frontend sends that
   input to the backend over the network.
4. The backend calculates the real premium using the private rate tables
   and sends back only the result.
5. The frontend displays it exactly as before — with the verified agent's
   name and phone number now also shown on the illustration and included
   when it's printed or saved as PDF.

Because this now depends on a live network call, it is **no longer fully
offline** — the backend server must be running and reachable. If it's
unreachable, the frontend shows a clear error message rather than
failing silently.

## Agent gate: consent + phone verification

Before using the calculator, every agent must:

1. **Accept the Terms and Conditions** — enter their name, tick a
   checkbox confirming they've read `TERMS.md` and accept personal
   responsibility for how they use the system, and continue.
2. **Verify their phone number via OTP** — a 6-digit code sent by SMS
   (see `backend/README.md` for wiring up a real SMS provider — no SMS
   is sent until you configure one).

Both steps are recorded **on the backend**, not just in the browser —
that's the part that actually matters if this is ever relied on for
liability purposes. The `agentToken` issued after verification is then
stored in the browser's `localStorage`, so returning agents on the same
device skip straight past the gate on future visits — matching "do this
once, on this phone."

**Important caveats, stated plainly:**

- This is a real, working consent + verification mechanism. Whether it
  legally shifts liability onto individual agents, or is sufficient given
  the system isn't yet company-authorised, is a legal question — have
  `TERMS.md` and this flow reviewed by a lawyer before relying on it.
- The backend audit trail (in the SQLite database) is only as durable as
  the disk it sits on. On Render's free tier the disk does **not** survive
  restarts — attach a persistent disk and set `DB_PATH`; see
  `backend/README.md`, "The database", before this is used with real
  agents.
- `localStorage` only saves the agent's session so they aren't asked to
  re-verify on every visit. It is **not** what grants access: every
  calculation request carries the agent's token and the **server** checks
  it against its own records, so clearing, editing or copying
  `localStorage` gets nobody in, and revoking an agent takes effect on
  their next request. (Earlier versions enforced the gate only in the
  browser; that's fixed and tested.)

## Deployment

There are two ways to deploy this. **Single-host is recommended** —
it's simpler, has no CORS to configure, and isn't tied to GitHub Pages
or Render specifically.

### Option A: Single-host (recommended)

The backend (`backend/server.js`) serves the frontend's static files
itself — one Node service is the whole app, API included. Deploy it to
**any** Node host: Render, Railway, Fly.io, DigitalOcean, a plain VPS,
whatever you have. This repo isn't GitHub-specific at all; GitHub is
just where the code happens to live if you use it for source control.

1. Deploy this repository (or just the `backend/` and `frontend/`
   folders together, kept as siblings exactly as they are here) to a
   Node host, pointing its start command at `backend/` (`npm install`
   then `npm start`).
2. Leave `frontend/config.js` alone — it auto-detects same-origin mode
   and needs no editing.
3. Set a few environment variables on that host before going live —
   see `backend/README.md` for the full list (`ADMIN_SECRET` is the
   important one; don't skip it).
4. Open the deployed URL directly — it serves the full app.

That's it — one deployment, one URL, no separate frontend host.

### Option B: Split hosting (frontend and backend on separate hosts)

Useful if you specifically want free static hosting (GitHub Pages,
Netlify, etc.) separate from wherever the backend runs, or if you're
already set up this way. GitHub Pages specifically cannot run a Node
server, so in split mode the two pieces deploy to two different places:

#### 1. Deploy the backend first

Follow `backend/README.md` — in short, connect this repository to
[Render.com](https://render.com) (free tier), pointing it at the
`backend/` folder. Render will give you a live URL, e.g.:

```
https://medical-premium-illustrator-api.onrender.com
```

#### 2. Point the frontend at it

Edit `frontend/config.js` and override the default with your backend's
URL:

```js
const API_BASE_URL = 'https://medical-premium-illustrator-api.onrender.com';
```

Commit and push that change.

#### 3. Deploy the frontend to GitHub Pages

This repo includes `.github/workflows/pages.yml`, which automatically
publishes the `frontend/` folder to GitHub Pages on every push to `main`
(GitHub Pages' simple branch-deploy option can't serve an arbitrary
subfolder, so this uses the officially supported GitHub Actions method
instead).

To turn it on:

1. Push this repository to GitHub.
2. Go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **GitHub Actions**.
4. Push any change (or re-run the workflow from the **Actions** tab).
5. Your site will be published at:

   ```
   https://<your-username>.github.io/<your-repo>/
   ```

From then on, any push that touches `frontend/**` redeploys automatically.

## Running it all locally first (recommended)

Before deploying anywhere, test on your own machine:

```bash
cd backend
npm install
npm start          # starts the API on http://localhost:3001
```

**To test single-host mode** (recommended, matches how it'll actually be
deployed): once the server is running, just open
**`http://localhost:3001/`** in your browser — the backend serves the
frontend itself, and `config.js` auto-detects this and talks to the same
origin with no editing needed.

**To test with the frontend opened as a plain file instead** (e.g. if
you're editing frontend files and don't want to restart the backend to
see changes): open `frontend/index.html` directly by double-clicking it
or typing its `file://` path — `config.js` detects this case too and
falls back to `http://localhost:3001` automatically.

Either way, you'll hit the agent gate first — accept the terms, enter
any phone number, click Send Verification Code, then look at the
terminal where `npm start` is running: the 6-digit code is printed
there (no real SMS is sent until you configure a provider — see
`backend/README.md`). Enter that code, and you're through to the app.

## Automated tests

```bash
cd backend && npm install && npm test    # all backend tests, incl. HTTP integration tests
cd admin && npm test                      # admin tools tests, no install needed
```

Current coverage: the calculation engines, the schema-equivalence
proof, OTP/agent/acceptance storage, branding and rate-import
validation, database persistence across process restarts, security
headers/rate limiting/admin lockout, and full HTTP integration tests.

These run automatically on every push via `.github/workflows/test.yml`.
The most important file is `backend/test/generic-engine.test.js` — it's
the proof that the guided-import schema engine (Phase 2) computes
identical results to the original hand-validated engine across 20
scenarios. See `ROADMAP.md`'s "Automated Testing" section for the full
breakdown of what's covered.

## Files in this repository

- `frontend/` — the app the user sees (deployed to GitHub Pages)
- `backend/` — the private rate engine and API (deployed to Render)
- `admin/` — internal admin tools, opened on your own computer and not
  deployed publicly. Start at `index.html`; it links to `agents.html`
  (view/revoke agents), `analytics.html` (usage + who-changed-what),
  `branding.html`, and `rate-import.html`. See "Using the admin tools"
  below.
- `.github/workflows/pages.yml` — auto-deploys `frontend/` to GitHub Pages
- `LICENSE` — All Rights Reserved copyright notice
- `TERMS.md` — Terms and Conditions of Use, the canonical, human-editable
  copy (a duplicate also lives at repo root for easy reference)
- `ROADMAP.md` — the longer-term plan for turning this into a
  multi-company, white-label platform, and what's been done toward that
  so far. Read this before starting any "make it more general" work.

## Branding (Phase 1 prototype — see ROADMAP.md)

Company name, product name, tagline, brand colors, and contact details
are no longer hardcoded — they're fetched from the backend at runtime via
`GET /api/branding`, and applied to the page title, the masthead, the CSS
theme, and the footer.

**To change branding:** open `admin/branding.html` in a browser (it talks
to whatever `API_BASE_URL` is set in `frontend/config.js`, so point it at
your running backend), fill in the fields, watch the live preview update,
and click **Save & Apply**. You'll need to be signed in as an admin — see
"Using the admin tools" below.

**What this is and isn't, honestly:**
- It genuinely re-themes the whole app from one saved config — no code
  changes needed. Try it: change the primary color and product name,
  save, then reload the main app.
- It is **not** multi-tenant yet — there's exactly one branding config
  for the whole system, not one per company. That's a Phase 1 limitation
  called out in `ROADMAP.md`; Phase 3 makes it one config per company.
- The branding config is stored in the SQLite database (see
  `backend/README.md`, "The database") — on a host with an ephemeral
  disk it needs a persistent volume to survive restarts.

### Editing the Terms and Conditions

The in-app "Read the full Terms" link and footer "Terms of Use" button
open a modal showing the terms text — they do **not** link to
`TERMS.md` directly (an earlier version did, and it broke when opened
outside a full deployment). The text shown in that modal is a separate,
embedded copy in `frontend/terms-content.js`.

**If you edit `TERMS.md`, you must regenerate `frontend/terms-content.js`
to match**, or the in-app modal will show stale text. Regenerate it with:

```bash
cd frontend
python3 -c "
content = open('TERMS.md').read()
escaped = content.replace('\\\\', '\\\\\\\\').replace('\`', '\\\\\`').replace('\${', '\\\\\${')
open('terms-content.js', 'w').write(
    '// Full Terms and Conditions text, embedded so the in-app link works\n'
    '// with no dependency on a separate file being present alongside this one.\n'
    'const TERMS_TEXT = \`' + escaped + '\`;\n'
)
"
```

Then also bump `TERMS_VERSION` near the top of `frontend/app.js` if the
change is material — this forces agents to re-accept the updated terms
rather than silently continuing under their old acceptance.

## Guided Rate Import (Phase 2 prototype — see ROADMAP.md)

`admin/rate-import.html` lets an admin add a **new** product (not
JCare/J-Junior/JSenior — those are permanently hardcoded and never
affected by this tool) by uploading a rate workbook and mapping cell
ranges to a structured schema, without writing calculation code.

**How to use it:**
1. Open `admin/rate-import.html`, upload the workbook (parsed in your
   browser — nothing is uploaded anywhere at this step).
2. Fill in Product Setup (id, name, covered roles, age eligibility).
3. Define tiers — type them manually or extract a row of limits by
   cell range (e.g. `D5:I5`).
4. For each benefit you want to include, pick a rate type (flat-per-tier
   or age-banded-per-role) and type in the cell range(s) — the tool
   shows you exactly what it extracted before you save anything.
5. **Build & Save Draft**, then **Run Preview** against a sample
   scenario and actually check the numbers against the source workbook
   yourself — the tool validates structure (right number of tiers,
   matching array lengths), not whether the rates are correct.
6. **Publish** — only then does `/api/calculate` serve this product live.

This needs you to be signed in as an admin, same as the branding tool. See
`ROADMAP.md`'s Phase 2 section for exactly what this wizard does and
doesn't cover yet (two rate patterns are supported in the UI today; the
underlying engine supports more, reachable via hand-edited schema JSON
in the meantime).

## Agent Management (Phase 4)

`admin/agents.html` shows every agent who has verified their phone and
accepted the Terms — with their name, number, first verification date,
last activity, and full acceptance history. You can revoke any agent's
access from here.

Sign in (see "Using the admin tools" below) and click **Load Agents**.

**Revoking takes effect on the agent's very next request** — the server
refuses their saved session and the app sends them back to the Terms and
phone-verification screen. (Earlier versions only *claimed* this; the
check lived in the browser alone. It's now enforced server-side and
covered by tests.) Revoking deliberately does *not* delete the record
that they previously accepted the Terms, because that record is the
evidence Sections 2/3 of `TERMS.md` rely on.

## Using the admin tools

The admin tools are plain files you open **on your own computer** — not
part of the public app. Open `admin/index.html` in a browser.

1. **Start the backend** (`cd backend && npm start`), or have your live
   one running. Each tool has a **Backend URL** bar at the top: leave it
   blank for a local backend, or paste your live address once (it's
   remembered, and shared across the tools).
2. **Create your admin account.** Set `ADMIN_BOOTSTRAP_USERNAME` and
   `ADMIN_BOOTSTRAP_PASSWORD` on the backend and restart it once. Then
   sign in with those details on any admin page — signing in on one
   carries across the rest. (Until you do this, the older shared
   `ADMIN_SECRET` still works under "No personal account yet?".)
3. **Use your own account, not the shared secret.** Anything done with
   your account is recorded under your name in the audit log (see
   `analytics.html`); anything done with the shared secret is logged
   only as `legacy-secret`.
4. **Sign out on shared computers** — staying signed in is remembered in
   the browser.

Adding another admin, resetting a forgotten password and removing
someone who has left are done on the server with `node admin-cli.js` —
see `backend/README.md`, "Admin accounts".

**Requires Node.js 22.13 or newer** (the database is Node's built-in
SQLite). Check with `node --version`.

## Usage & Activity (Phase 4)

`admin/analytics.html` shows how many illustrations have been generated
— by product, plan tier, agent and day — plus the admin activity log.
It holds **no client information**: an event records only the product,
tier, which verified agent, and when.

## A reminder on privacy for the repo itself

A license controls what people are *legally allowed* to do with your
code; it doesn't stop them from *viewing* a public repository. The
backend folder holds your actual rate tables in `data.json` — if you'd
rather those never be visible to anyone browsing GitHub, keep this
repository **private** rather than public. Render and GitHub Pages can
both deploy from a private repo (GitHub Pages from a private repo
requires a paid GitHub plan; Render's free tier works from private repos
without any extra cost).
