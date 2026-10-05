# Benbau DK PPE Tracker

Web app for PPE stock per location, handouts to workers (with signature and email receipt) and
transfers between locations. Works on phone and desktop. Data lives in SharePoint lists, and
users sign in with their Microsoft 365 work account.

It is plain HTML/CSS/JavaScript: no build step, no server, nothing to install.

```
index.html        page shell
config.js         <- your settings (client ID, tenant ID, SharePoint site)
css/app.css       styling
js/app.js         screens and UI logic
js/service.js     stock / handout / transfer rules
js/db-sharepoint.js  SharePoint (Microsoft Graph) storage
js/db-demo.js     demo storage (browser only)
js/schema.js      SharePoint list + column definitions, handout reasons
serve.ps1         local test server
```

## 1. Try it locally (demo mode)

While `clientId` in `config.js` is empty, the app runs in **demo mode** with sample data kept only
in your browser.

```bash
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open http://localhost:5500/. To try it on a phone, use the hosted version (step 5).

## 2. Create the SharePoint site

1. In SharePoint, create a site (for example a Team site called **PPE**), e.g.
   `https://benbau.sharepoint.com/sites/PPE`.
2. Add everyone who will use the app as **Members** (Edit permission). Those people can use the
   app; nobody else can see the data.

You don't create the lists yourself. The first time you sign in, the app offers to create them:

| List | Holds |
|---|---|
| PPE_Locations | Sites/stores (CPH, FRD2A, …) |
| PPE_Products | Products, brand, sizes, image URL |
| PPE_Stock | Quantity per product + size + location |
| PPE_Personnel | Workers (name, email, company, site, active) |
| PPE_Handouts | Every handout incl. reason, notes, date, who handed out, signature |
| PPE_Transfers | Moves between locations |

## 3. Register the app in Microsoft Entra ID

You may be able to do this yourself: by default every user can register apps. If the menu is
missing or you get "access denied", send the text in section 6 to IT.

1. Go to https://entra.microsoft.com → **Applications → App registrations → New registration**.
2. Name: `Benbau PPE Tracker`. Supported account types: **Accounts in this organizational directory only**.
3. Redirect URI: choose platform **Single-page application (SPA)** and enter `http://localhost:5500/`.
   Then **Register**.
4. On **Authentication**, add your hosted address as another SPA redirect URI (step 5), e.g.
   `https://YOURNAME.github.io/benbau-ppe/`. It must match exactly, including the trailing `/`.
5. On **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, add:
   `User.Read`, `Sites.ReadWrite.All`, `Mail.Send`, `Sites.Manage.All`.
   Then click **Grant admin consent** (needs an admin). If you skip it, each user is asked to
   accept the permissions the first time, unless your tenant blocks that.
6. From **Overview**, copy the **Application (client) ID** and **Directory (tenant) ID** into `config.js`,
   together with your `siteUrl`.

"Delegated" means the app only ever acts as the signed-in person, with that person's own
SharePoint permissions. Receipts are sent from the mailbox of the person who clicks the button.

## 4. First sign-in

Open the app, sign in, and click **Create lists**. Then open the menu (your initials, top right) →
**Manage locations** to add your locations, and add products with **+** on the Inventory tab.
Register stock with the product's **Edit** button.

## 5. Hosting

The app is static files, so any static host works. The app code is not secret: `config.js`
only has public IDs, and all data is behind Microsoft sign-in.

### Option A: GitHub Pages (simplest, free)
1. Create a GitHub account and a new repository, e.g. `benbau-ppe`. Free GitHub Pages needs a
   **public** repository; private repos need a paid plan.
2. Upload all files in this folder (**Add file → Upload files**, drag the folder contents in, commit).
   No git installation is needed.
3. **Settings → Pages → Source: Deploy from a branch → main / (root) → Save**.
4. After a minute the app is live at `https://YOURNAME.github.io/benbau-ppe/`. Add that exact
   address as a SPA redirect URI in Entra (step 3.4).
5. To update the app later, upload the changed files again.

### Option B: Azure Static Web Apps (free tier, can use a private repo)
Microsoft-hosted, can deploy from a **private** GitHub repo, and supports a custom domain such as
`ppe.benbau.dk`. In the Azure portal, create a **Static Web App** (Free plan), connect it to your
GitHub repo, and set build preset **Custom** with app location `/` and no build command. Add the
resulting `https://….azurestaticapps.net/` address as a redirect URI.

### Option C: Netlify Drop
Go to https://app.netlify.com/drop and drag this folder onto the page. You get a URL in seconds.
Add it as a redirect URI.

### Put it on the phone home screen
Open the hosted URL on the phone. On iPhone: Share → **Add to Home Screen**. On Android: menu →
**Add to Home screen** / **Install app**. It then opens full-screen like an app.

## 6. Text to send to IT (if needed)

> Hi, I've built a web app for tracking PPE on our construction sites. It stores its data in a
> SharePoint site and signs users in with their Microsoft 365 accounts. Could you please create an
> app registration in Entra ID for it:
>
> - Name: Benbau PPE Tracker, single tenant
> - Platform: Single-page application, redirect URIs: `http://localhost:5500/` and `<hosted URL>`
> - Microsoft Graph **delegated** permissions: User.Read, Sites.ReadWrite.All, Sites.Manage.All, Mail.Send,
>   with admin consent granted
>
> The app only acts as the signed-in user (no application permissions and no client secret). Please send me the
> Application (client) ID and Directory (tenant) ID. Thanks!

## Notes
- **Concurrent use:** stock changes use SharePoint version checks, so two people handing out the same item at
  the same time can't both take the last one.
- **Deleting a handout** can return the items to stock. Deleted items go to the SharePoint site's recycle bin.
- **Handout reasons** are in `js/schema.js` (`REASONS`).
- **Product images** are optional. Paste a public image URL (for example from the supplier's website).
