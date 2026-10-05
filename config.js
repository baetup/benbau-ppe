// App configuration — edit these values after creating the Entra ID app registration.
// While clientId is empty the app runs in DEMO mode (sample data stored only in your browser).
window.PPE_CONFIG = {
  // Application (client) ID from Entra ID > App registrations > your app > Overview
  clientId: "",

  // Directory (tenant) ID from the same Overview page (or your domain, e.g. "benbau.dk")
  tenantId: "",

  // The SharePoint site that holds the PPE lists
  siteUrl: "https://YOURTENANT.sharepoint.com/sites/PPE",

  // Name shown in the header, login screen and email receipts
  appName: "Benbau DK PPE Tracker",

  // Optional. Leave empty to use the current page address as the sign-in redirect URI.
  redirectUri: ""
};
