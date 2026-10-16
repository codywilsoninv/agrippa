// Connections hub: what each provider asks for and exactly where to find it.
// Pure data (no server code), so screens and modules can both read it.
// Add a provider here once; any module can then list it as a connection it needs.

export type Provider = "pipedrive" | "acuity" | "clicksend" | "gmail";

export type ProviderField = {
  name: string;
  label: string;
  type?: "text" | "password";
  placeholder?: string;
  /** Short note under the box. */
  hint?: string;
};

export type ProviderGuide = {
  name: string;
  /** False = Agrippa can't connect to it yet (shown as "coming"). */
  available: boolean;
  fields: ProviderField[];
  /** Click-by-click: where to find each value. Written for someone who has never done it. */
  steps: string[];
  /** Something to know before connecting (what access it grants, what not to click). */
  caution?: string;
};

export const PROVIDERS: Record<Provider, ProviderGuide> = {
  pipedrive: {
    name: "Pipedrive",
    available: true,
    fields: [
      { name: "company_domain", label: "Company domain", placeholder: "yourcompany", hint: "The first part of your Pipedrive address: yourcompany.pipedrive.com" },
      { name: "api_token", label: "API token", type: "password" },
    ],
    steps: [
      "Sign in to Pipedrive.",
      "Look at the address bar: the word before .pipedrive.com is your company domain. Type it into Company domain.",
      "Click your initials or photo at the top right, then Personal preferences. (Or open Settings and choose Personal preferences under My account.)",
      "Open the API tab at the top of that page.",
      "Next to Your personal API token, click the copy icon, then paste it into API token here.",
    ],
    caution: "Don't click Generate new token: that switches off the old token everywhere it is used.",
  },
  acuity: {
    name: "Acuity Scheduling",
    available: true,
    fields: [
      { name: "user_id", label: "User ID", placeholder: "12345678" },
      { name: "api_key", label: "API key", type: "password" },
    ],
    steps: [
      "Sign in to Acuity Scheduling.",
      "In the left menu, click Integrations.",
      "Scroll down to Analytics + Custom Integrations and find the API card.",
      "Click View credentials (not Developer's site).",
      "Copy the User ID (a number) into User ID here, and the API Key into API key.",
    ],
    caution: "If there is no API card, your Acuity plan may not include API access.",
  },
  clicksend: {
    name: "ClickSend",
    available: true,
    fields: [
      { name: "username", label: "API username", placeholder: "you@yourcompany.com" },
      { name: "api_key", label: "API key", type: "password" },
    ],
    steps: [
      "Sign in at dashboard.clicksend.com.",
      "Open Developers in the top menu, then API Credentials. (If you can't see it, search the dashboard for \"API credentials\".)",
      "Copy the Username into API username here.",
      "Copy the API Key into API key.",
    ],
    caution: "This key could also send texts, which cost money. Agrippa only reads texts for now, and when sending arrives, every message needs a person to approve it.",
  },
  gmail: {
    name: "Gmail",
    available: true,
    fields: [
      { name: "email", label: "Gmail address", placeholder: "you@yourcompany.com" },
      { name: "app_password", label: "App password", type: "password", hint: "16 letters from Google; spaces are fine" },
    ],
    steps: [
      "Sign in to the Google account whose inbox you want Agrippa to read (for example bookings@yourcompany.com).",
      "Go to myaccount.google.com and click Security in the left menu.",
      "Under \"How you sign in to Google\", make sure 2-Step Verification is On. If it's off, click it and follow the steps to turn it on first.",
      "Go to myaccount.google.com/apppasswords (you may be asked to sign in again).",
      "In the App name box type Agrippa, then click Create.",
      "Google shows a 16-letter code once. Copy it and paste it into App password here, then type the Gmail address into Gmail address.",
    ],
    caution:
      "If Google says the setting isn't available, the Workspace admin has turned app passwords off (Admin console → Security → Authentication → 2-Step Verification). Agrippa only reads mail; it never sends.",
  },
};

/** How much a module depends on a connection. */
export type Need = "required" | "optional" | "later";

export type ModuleConnection = {
  provider: Provider;
  need: Need;
  /** One line: what the module uses it for. */
  why: string;
};
