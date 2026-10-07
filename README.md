# Benbau PPE Tracker

Web app for PPE stock per location, handouts to workers (with signature and receipt) and
transfers between locations, for Denmark and Sweden. Works on phone and desktop.

- **Hosting:** GitHub Pages (static files, no build step)
- **Database & logins:** Supabase (free tier). You create the user accounts yourself.

```
index.html            page shell
config.js             <- your settings (Supabase URL + key, countries)
supabase/setup.sql    database setup: paste into the Supabase SQL editor
css/app.css           styling
js/app.js             screens and UI logic
js/service.js         app logic
js/db-supabase.js     Supabase storage
js/db-demo.js         demo storage (browser only)
js/receipt.js         receipt preview / text / image
js/schema.js          handout reasons
serve.ps1             local test server
```

## 1. Create the Supabase project (once)

1. Sign up at https://supabase.com (free) and click **New project**.
   - Name: `benbau-ppe`
   - Database password: generate one and store it safely. The app doesn't need it.
   - Region: **Europe (Frankfurt or Stockholm)**, so the data stays in the EU.
2. When the project is ready, open **SQL Editor → New query**, paste the whole contents of
   `supabase/setup.sql`, and click **Run**. This creates the tables, the security rules and the starter
   locations (CPH, FRD2A, Ersbo, Kungsgarden, Stackbo).
3. **Authentication → Sign In / Providers**:
   - turn **off** "Allow new users to sign up"
   - keep **Email** enabled; you can turn off "Confirm email", since you create the users yourself.
4. **Authentication → URL Configuration**: set **Site URL** to `https://baetup.github.io/benbau-ppe/`
   and add the same address under **Redirect URLs**. This is needed for "Forgot password?" emails.
5. **Project Settings → API Keys**: copy the **publishable key** (or the legacy **anon public** key).
   Then find the **Project URL** (Project Settings → Data API, or the **Connect** button), and put both into `config.js`:

   ```js
   supabaseUrl: "https://abcdefgh.supabase.co",
   supabaseKey: "sb_publishable_…",
   ```

   Never use the **secret** / **service_role** key in the app.

## 2. Add a user (each time someone needs access)

Two steps in the Supabase dashboard:

1. **Authentication → Users → Add user → Create new user**: enter their email and a starting password
   and tick **Auto Confirm User**.
2. **Table Editor → staff → Insert row**: the same **email** plus their **name**. The name appears as
   "Handed out by" on handouts and receipts.

Give the person the app address, their email and the starting password. They can change the password
in the app (menu → **Change password**) or with **Forgot password?** on the login screen.

**To remove access:** delete the person's row in `staff`. They are locked out of all data immediately.
You can also delete the user under Authentication → Users.

## 3. Publish the app on GitHub Pages

In the `benbau-ppe` repository on GitHub, upload the files from this folder, keeping the folders
(`css`, `js`, `img`, `supabase`). The easiest way is to drag the folders onto **Add file → Upload files**.
Pages is already switched on, so the app updates at https://baetup.github.io/benbau-ppe/ a minute later.

Delete these old files from the repository if they are still there: `js/auth.js`, `js/graph.js`,
`js/db-sharepoint.js`.

While `supabaseUrl` and `supabaseKey` are empty, the app runs in **demo mode** with sample data kept
only in the browser. Add `?demo` to the address to see demo mode later on.

### Put it on the phone home screen
Open the address on the phone. On iPhone: Share → **Add to Home Screen**. On Android: menu →
**Add to Home screen** / **Install app**.

## How it works

### Security
- The publishable key in `config.js` is meant to be public. It only lets the app talk to the database;
  what anyone can read or change is decided by the database's security rules (row level security).
- Only signed-in users whose email is in the `staff` table can see or change any data.
  Everyone else, including someone who has the key, gets nothing.
- Handouts, transfers and stock changes run as database functions. Each one completes fully or not at
  all, so two people can't both take the last item, and a failed handout never leaves stock half-changed.
- "Handed out by" is filled in by the database from the signed-in user, so it can't be faked.

### Countries
- The countries are listed in `config.js` (`countries`). Each location belongs to one
  (**Menu → Manage locations**).
- The **DK / SE** button in the header switches country. Each phone or PC remembers its choice.
  The location list and the personnel list then show only that country. A person belongs to the
  country of their site; people without a site show in every country.
- Products are shared. Stock is kept per location. Transfers can go to any location.

### Dashboard tab
Choose a **country**, **location** (or all) and **consumption period**:
- **Tiles:** items handed out (with number of handouts and people), items in stock now, sizes out of
  stock, sizes running low. Tap the out-of-stock / running-low tiles to jump to the problem list.
- **Items handed out per week / month:** column chart (weekly for periods up to 3 months). Tap a
  column for the exact number.
- **Most used equipment**, **By location** and **By reason:** ranked bars. Tap equipment to open those
  handouts in History.
- **Stock check:** with all locations, a product × location table of totals (tap a number to see each
  size); with one location, every product with its sizes. **Out** = a size that ran out, **Low** =
  `lowStock` (config.js, default 2) or fewer left. Sizes never stocked at a location are not counted
  as out. Tick "Only out of stock / running low" to see just the problems.
- The numbers are calculated in the database, so the dashboard stays fast with a large history.

### History tab
All handouts, filterable by **country, location, equipment, reason, period** (this/last week, month,
year, last 30 days / 12 months, all time or custom dates) and **person**. You can sort by date, person,
equipment or location.
- Filtering, sorting and paging run in the database, 50 rows at a time (**Load more**), so it stays
  fast with tens of thousands of handouts.
- **Totals by equipment** shows how many items of each product and size were handed out in the selection.
- **Export CSV** downloads every row matching the filters (not just the loaded ones). The file uses
  semicolons, so Excel opens it directly.
- Click a row to see its receipt with the signature.

### Stock change log (History → Stock changes)
Every change to a stock quantity is recorded automatically by the database: **when, who, which product,
size and location, old → new quantity**, the type of change and a note.
- Types: **Manual edit** (product Edit form; a reason such as "Delivery received" is required),
  **Handout** (note: who received it), **Transfer** (to/from which location), **Handout deleted**
  (items returned to stock), **Size exchange**, and **Database edit** (changed directly in the Supabase
  dashboard).
- The log is written by a database trigger, so it can't be skipped. App users can read it but can't
  change or delete it.
- Filter by country, location, equipment, type, period and who made the change. **Export CSV** works here too.
- Shortcut: in a product's **Edit** form, click **Show stock history of … at …**.

### Changing a handout
The ✎ button on a handout card (Personnel tab) opens **Change handout**:
- **Exchange size**: choose the new size, how many to exchange and the location where it happens.
  The old size goes back into stock and the new size is taken out, in one step. The handout keeps its
  original date and signature, and a note records the exchange. Exchanging only part of a handout
  (e.g. 1 of 2 pairs of boots) splits it into two records.
- **Delete handout**: with the option to return the items to stock.

### Receipts
The download button on a handout card, and the "Show receipt after saving" option when saving a
handout, show the receipt with a **Download receipt image** button: a PNG of the receipt including
the signature.

### Data & backups
- View and export the data in Supabase **Table Editor** (each table has **Export to CSV**).
- The free plan has no automatic backups. Export the tables to CSV now and then (e.g. monthly),
  or upgrade to the Pro plan for daily backups.
- A free project is paused after 7 days without any use. Daily use keeps it active. If it does pause,
  click **Restore** in the Supabase dashboard.
- **GDPR:** the app stores worker names, contact details and signatures. Accept Supabase's
  Data Processing Agreement (dashboard → Organization → Legal documents) and keep the project in an EU region.

## Testing locally

```bash
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open http://localhost:5500/. To use the real database locally, also add `http://localhost:5500/`
to the Supabase Redirect URLs.

## Changing things
- **Handout reasons:** `js/schema.js` (`REASONS`)
- **Countries / app name:** `config.js`
- **Product images:** optional. Paste a public image URL in the product's Edit form.
