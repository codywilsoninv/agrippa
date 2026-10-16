import type { ModuleConnection } from "@/lib/providers";

// Manifest section 4: the connections Messaging uses, in setup order.
// The Settings screen and the inbox read this list, so adding a capability
// here makes it appear (with its how-to) everywhere.
export const MESSAGING_CONNECTIONS: ModuleConnection[] = [
  {
    provider: "pipedrive",
    need: "required",
    why: "Reads clients, enquiries, notes, and the email synced into Pipedrive's Sales Inbox (the inbox of whoever owns the API token). Approved drafts are saved back as a note.",
  },
  {
    provider: "acuity",
    need: "required",
    why: "Reads each artist's free days so drafts only offer dates that are really open.",
  },
  {
    provider: "clicksend",
    need: "required",
    why: "Reads every text in and out, including from clients whose deal is already won, booked or lost. Sending from Agrippa comes in version 0.2.",
  },
  {
    provider: "gmail",
    need: "later",
    why: "Not needed while email syncs into Pipedrive.",
  },
];
