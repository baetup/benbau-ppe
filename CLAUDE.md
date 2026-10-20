# Benbau PPE Tracker — project notes

Read this first. Decisions, rules and conventions agreed with Petru (the owner). Keep it up to date when
something changes. Do NOT upload this file to GitHub (the repository is public).

## What it is
Web app to track PPE stock per location, handouts to workers (with signature), returns, transfers,
lost/rotation PPE of subcontractors, orders, history and a dashboard. Used on phones and desktop.
Company: Benbau (main company). Countries: Denmark (DK: CPH, FRD2A) and Sweden (SE: Kungsgarden, Ersbo, Stackbo).

## Stack & hosting
- Plain HTML/CSS/JS, ES modules, **no build step**, no Node on the user's PC (no git either).
- Database + logins: **Supabase** (project `yquaxsgtgidcpwlcivqp`, EU). Publishable key in `config.js` (public by design).
- Hosting: **GitHub Pages**, repo `baetup/benbau-ppe` (public), custom domain **benbau-ppe.com** (Squarespace DNS → GitHub).
- The user uploads changed files to GitHub by hand → **always end with the exact list of files to upload**,
  and say clearly when `supabase/setup.sql` must be run again (and whether files must be uploaded right after).
- Local test server: `serve.ps1` / `.claude/launch.json` ("ppe", port 5500).

## Files
- `config.js` — settings (Supabase URL/key, appName, countries, mainCompany, sizeTypes, orderSettings,
  lowStock, incidentsEnabled, incidentTypes/Actions, branches, demoEnabled). The user edits it too.
- `supabase/setup.sql` — the whole database. **Idempotent: always safe to re-run**; new columns via
  `add column if not exists` or `do $$ … if not exists … $$` blocks (one-time migrations live inside those).
  Ends with `notify pgrst, 'reload schema'`.
- `js/app.js` (main UI), `ui.js` (h(), modals, toasts, busy, suggestInput), `service.js` (logic/roles),
  `db-supabase.js` (Supabase), `db-demo.js` (demo store + seed, localStorage), `dashboard.js`, `charts.js`,
  `orders.js`, `workforce.js` (status, returns, crews, lost/rotation report), `incidents.js` (hidden),
  `receipt.js`, `signature.js`, `icons.js`, `schema.js` (handout REASONS).
- `README.md` — the user **replaced it with their own text; don't overwrite it.**

## Code conventions
- App fields are PascalCase (`ProductId`, `HandoutDate`); DB columns snake_case. `db-supabase.js` converts.
- `h(tag, props, ...children)` skips null children, but **`element.replaceChildren(...)` does NOT** — passing
  `null` prints the text "null" (this bug happened 3 times). Use `.filter(Boolean)` or spread `[...]`.
- Stock-changing operations are DB functions (all-or-nothing): create_handout, create_transfer, set_stock,
  record_return, delete_handout, exchange_handout, adjust_stock. Demo store mirrors them (keep both in sync).
- Every stock quantity change is logged by trigger `log_stock_change` → `stock_log` (source + note via
  `ppe_context`). Sources: Manual edit (reason required in UI), Handout, Return, Transfer, Handout deleted,
  Size exchange, Database edit.
- Supabase delete with RLS denial deletes nothing silently → `remove()` checks rows were deleted.
- Demo data key `ppe-demo-db-vN` in db-demo.js: bump N when the seed changes (old keys are cleaned up).
- Native `<datalist>` popups were mispositioned in modals → use `suggestInput()` instead.

## Roles (enforced in the DB: can_operate, in_my_country, can_manage_product, is_admin)
- **Admin**: all countries; Users & roles, Manage locations; everything.
- **Lead**: own country only (app locked to it); hand out / stock / returns / exchanges anywhere in the
  country; create/edit/delete products, types & seasons of their country.
- **Officer**: own country; hand out, change stock, receive returns, exchange sizes **only at own location**;
  transfer **only from own location** to other locations in the country; other locations are view-only
  (Add disabled + note). App always opens at the officer's location; leads always in their country.
- **No transfers between countries for anyone.**
- Staff rows: `staff(email, name, role, country, location_id)`. Logins are created in Supabase Auth
  (same email). Admins manage roles in the app (menu → Users & roles). Pre-role staff became admin.
- Reads are locked per country too (since 20 Oct 2026, see Security model).

## Data model decisions
- **Products belong to one country** (different products/standards). Lists show the current country only.
  DB `check_product_country` refuses using a product at another country's location.
- Product **category**: `regular` or `consumable`. Consumables never count as lost/rotation (returnable=false).
- Product **type** (cards in Inventory: Jackets, Vests…; separate for regular/consumable, per country) and
  **season** (Summer/Winter/Rain/All season, per country) in table `catalog_options` (list='type'|'season').
  Managed by admins/leads (Inventory → Types). Search always covers all types of the country.
- Product **size type** ("Matches worker size") links to a worker size for Orders.
- **Worker sizes**: types configurable in `config.sizeTypes`; stored in `personnel.size_profile` (jsonb, keyed
  by type name; old columns boots_size… kept as fallback). Renaming a type starts it empty.
- **Returned stock**: `stock.returned_quantity` is the part of quantity that is used/returned PPE. Handout
  form has a "Returned PPE" tickbox per item. Transfers do not keep the "returned" label (known, accepted).
- Locations have a country. Header DK/SE switch for admins.

## Workforce rules
- Worker status: On site / In rotation / Left (`active`, `in_rotation`). **Rotation only for subcontractors.**
- **mainCompany = Benbau**: no rotation, excluded from lost/rotation reports. All other companies are tracked.
- **Lost PPE** = returnable PPE still held by subcontractor workers who left.
- **Rotation PPE** = PPE held by subcontractor workers in rotation. **NOT expected back** — just a count.
- Returns: per handout item, "back in stock" (as returned stock) or discarded; recorded in `returns`.
- Reports are per country (no mixing), grouped company → equipment → size, with workers list, CSV export.

## Other features & settings
- Handout warns if the same product (any size) was received in the last 3 months.
- Size exchange / delete handout from the handout card. Receipts: download image only (no email).
- Orders tab (per location; Regular/Consumables tabs; collapsible card per product; columns Workers, In stock,
  Used/month, Suggested; no "Short" column). Suggested = use/month × coverMonths + workers × workerBuffer − stock
  (orderSettings). Use = stock_log decreases from Handout + Manual edit (consumables are counted manually).
- Dashboard is the default/first tab (tabs: Dashboard, Inventory, Personnel, History, Orders). Stock check at
  the top with Regular/Consumables tabs. lowStock (user set it to 10).
- History tab: Handouts / Stock changes, server-side filters & paging (thousands of rows), CSV export.
- Incidents tab exists but is **hidden** (`incidentsEnabled: false`) — user undecided; don't remove it.
- Demo: `?demo`; on the website only when `demoEnabled: true` (currently false); always works on localhost.
  Demo menu: Switch demo user (8 users: admin, lead DK/SE, officer per location), Reset demo data.

## Testing habits (important)
- Test in the built-in browser at `http://localhost:5500/?demo` and **check the demo banner before every
  action**. The test browser also holds a **live** Supabase session (user "Claudia Borze") — never click or
  change anything on the live app (`/` without `?demo`). Once a test accidentally changed the live page's
  location dropdown; avoid that.
- Check phone width (375px) and desktop; check no horizontal overflow and no console errors.

## Working with Petru
- Non-developer; explain in plain language, short. Mentions screenshots of problems; fix + test + list files.
- Prefers features built directly after a short design note; asks follow-ups in chat.
- Wants: per-country separation, role-based access, mobile-friendly UI, collapsible/clean screens.

## User guide (folder `guide/`, NOT for GitHub)
- `guide/Benbau PPE Tracker - User Guide.pdf` (21 A4 pages, made Oct 2026) and `guide/Email to management.txt`.
- Source: `guide/guide.html` (A4 pages, Montserrat, orange style of the old Power Apps guide, Benbau logo,
  hero photo taken from the old guide). Screenshots in `guide/shots/` come from the demo app with orange
  numbered markers (made with headless Edge: `guide/tools/cdp.ps1` + `helpers.js`, port 9333, own profile —
  never the live session). PDF = cdp.ps1 `-Pdf` on http://localhost:5500/guide/guide.html.
- If the UI changes a lot, retake the affected screenshots and re-print the PDF.
- The email points management to benbau-ppe.com/?demo → `demoEnabled` must be true in config.js on the website.
- Developer guide: `guide/DEVELOPER.md` (source) → `guide/developer.html` renders it (marked + mermaid) →
  `guide/Benbau PPE Tracker - Developer Guide.pdf` (cdp.ps1 `-Pdf … -Footer guide/tools/dev-footer.html`).
  Internal (describes the security model in detail). Keep DEVELOPER.md in sync when architecture changes.

## Security model (fixed 20 Oct 2026 after an external audit, "Five Critical Fixes")
- Writes to stock/handouts/transfers/returns ONLY via SECURITY DEFINER functions (no table write policies).
  `adjust_stock` lives in schema `app_internal` (not exposed, not executable by users).
- Reads are per country for leads/officers (policies use `(select is_admin())` / `location_id in (select
  my_location_ids())` / `country = (select my_country())`). Workers without a site: admin only.
- Helpers never return NULL; guards use `is not true`. Staff constraints (role, lead country, officer location;
  NOT VALID + validate, NOTICE if old rows break them). staff.location_id ON DELETE RESTRICT.
- products.country NOT NULL; trigger blocks changing the country of a product in use.
- **Petru's decisions:** officers serve ANY worker of their own country (not only own site); size exchanges need a
  NEW signature (whole exchange: old signature → `signature_history`; partial: new row, new batch, today, reason
  Size Change). Workers must have a site (app + DB).
- `audit_log` (admin-only, trigger `audit_row` on personnel/staff/handouts/incidents/returns/transfers/locations/
  products/catalog_options; signatures stored as sha256 digest). stock_log has no FKs; logs deletes and
  returned-only changes; sources incl. Product deleted / Location deleted / Deleted.
- delete_handout(id, toStock, reason): reason required in the app (modal with suggestions).
- Incident edits: changing the facts drops the old signature unless re-signed.
- **DB tests:** `guide/tools/db-tests.html` = PGlite (real Postgres in browser) with Supabase stubs; fresh install +
  upgrade from `guide/tools/setup-before-security-fix.sql`, ~70 role/country checks. Run after every setup.sql change
  (via cdp.ps1, read window.result). All 70 passed on 20 Oct 2026.
- Still advised to Petru: disable Supabase public sign-up; run setup.sql on a separate Supabase TEST project first;
  organisational items from the audit (company-owned accounts, paid plan + backups, DPAs with Supabase/GitHub).

## To do later (not done yet — Petru: "we can deal with them later")
1. ~~Hide other countries' data~~ — done with the security fix (20 Oct 2026). Possible next: an admin screen for
   the audit log / signature history.
2. **Import old data** from SharePoint lists / spreadsheets (history, workers, stock). Waiting for CSV
   exports from Petru; then a one-time import (map names → products/locations/workers).
3. **Private hosting** — the site/repo is public now (data itself is protected by logins). Options:
   private repo needs GitHub Pro, or move to Azure Static Web Apps / Netlify / Cloudflare Pages.
4. **Automatic receipt emails** — now download-only. Would need Resend (or similar) + a Supabase Edge Function.
5. **Incidents/NCR tab** — built but hidden (`incidentsEnabled: false`); decide whether to enable.
   If enabled (or more modules added), consider renaming the app (`appName`).
