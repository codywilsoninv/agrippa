import type { ModuleConnection } from "@/lib/providers";

// Manifest section 4: the connections Messaging uses, in setup order.
// The Settings screen and the inbox read this list, so adding a capability
// here makes it appear (with its how-to) everywhere.
export const MESSAGING_CONNECTIONS: ModuleConnection[] = [
  {
    provider: "pipedrive",
    need: "required",
    why: "Reads enquiries, client details, notes and the texts ClickSend logs there. Approved drafts are saved back as a note on the deal.",
  },
  {
    provider: "acuity",
    need: "required",
    why: "Reads each artist's free days so drafts only offer dates that are really open.",
  },
  {
    provider: "clicksend",
    need: "later",
    why: "For sending texts straight from Agrippa (version 0.2). Not used yet: texts are read from Pipedrive.",
  },
  {
    provider: "gmail",
    need: "later",
    why: "For reading email replies and sending emails from Agrippa (version 0.2).",
  },
];
