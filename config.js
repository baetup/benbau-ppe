// App configuration.
// While supabaseUrl / supabaseKey are empty the app runs in DEMO mode (sample data stored only in your browser).
window.PPE_CONFIG = {
  // Supabase > Project Settings > Data API (or "Connect") > Project URL, e.g. "https://abcdefgh.supabase.co"
  supabaseUrl: "https://yquaxsgtgidcpwlcivqp.supabase.co",

  // Supabase > Project Settings > API Keys > the "publishable" key (sb_publishable_...) or the legacy "anon public" key.
  // This key is meant to be public. NEVER put the "secret" / "service_role" key here.
  supabaseKey: "sb_publishable_6PVzxXyALN3KDf-u7DwiUw_I6JRc-5t",

  // Name shown in the header, on the login screen and on receipts
  appName: "Benbau PPE Tracker",

  // Countries the app covers. Each location belongs to one of these (set in Menu > Manage locations).
  // The first one is the default. Add more lines to add more countries.
  countries: [
    { code: "DK", name: "Denmark" },
    { code: "SE", name: "Sweden" }
  ],

  // Dashboard: a size counts as "running low" when this many or fewer are left
  lowStock: 2
};
