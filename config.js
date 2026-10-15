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

  // Demo with sample data at <address>?demo. false = "?demo" is ignored on the website (people get the
  // normal login screen). On your own PC (http://localhost) the demo always works for testing.
  demoEnabled: true,

  // Countries the app covers. Each location belongs to one of these (set in Menu > Manage locations).
  // The first one is the default. Add more lines to add more countries.
  countries: [
    { code: "DK", name: "Denmark" },
    { code: "SE", name: "Sweden" }
  ],

  // The main company. Its workers have no rotation status and are left out of the lost / rotation PPE reports.
  mainCompany: "Benbau",

  // Size boxes on each worker's profile (in this order). Add, remove or reorder freely.
  // A product is linked to one of these in its Edit form ("Matches worker size") for the Orders tab.
  // Renaming a type starts it empty: sizes are stored under the type's name.
  sizeTypes: ["Boots", "Jacket", "Trousers", "Vest", "Termo Top","Termo Trouser","Rain Jacket","Rain Trousers","Winter Jacket"],

  // Orders tab suggestion:
  //   suggested = average use per month (last historyMonths) × coverMonths + workers with that size × workerBuffer − stock
  orderSettings: {
    historyMonths: 3,   // how far back to look at use (handouts + stock decreases from counts)
    coverMonths: 2,     // how many months the order should last
    workerBuffer: 0.1   // spare per worker with that size (0.1 = 10%)
  },

  // Dashboard: a size counts as "running low" when this many or fewer are left
  lowStock: 10,

  // Incidents tab on/off. false = hidden (nothing is deleted); set to true to show it again.
  incidentsEnabled: false,

  // Incidents: the choices in the incident form (edit freely; order = order in the lists)
  incidentTypes: ["Health and Safety", "Quality", "Other Policy"],
  incidentActions: ["General NCR", "Verbal Coaching", "Yellow Card", "Red Card"],
  branches: ["Benbau", "HIROS", "Dipwork", "Nortabyg", "TSI"]
};
