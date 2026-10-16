// Messaging module v0.1: shared types. See docs/modules/messaging/manifest.md.
//
// Company-specific content (voice, price book, roster, routing) is company-layer
// DATA, stored per workspace in workspace_modules.settings (module_id 'messaging').
// Nothing business-specific may be hard-coded in this module.

export const MODULE_ID = "messaging";
export const MODULE_VERSION = "0.1.0";

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday

export type Artist = {
  name: string;
  active: boolean;
  /** Booked through the business (true) or runs their own books (false: never route to them). */
  in_house: boolean;
  /** Acuity calendar for this person. Absent = dates come from a human (no slots offered). */
  acuity_calendar_id?: number;
  /** Acuity appointment type used to check a full tattoo/session slot. */
  acuity_appointment_type_id?: number;
  /** Local start time of a session, "HH:MM". A day is only offered if this exact start is free. */
  day_start: string;
  /** Days this person can take a session. Absent = any day Acuity shows. */
  works_days?: Weekday[];
  /** One line the draft must include whenever this person is offered (e.g. hand poke). */
  must_mention?: string;
  note?: string;
};

export type StyleRoute = {
  name: string;
  /** How to recognise the style from an enquiry. */
  description: string;
  /** Artist name → rank (1 = first). Only ranked artists are eligible. */
  ranks: Record<string, number>;
  /** No quote, offer a consult first (e.g. cover-ups). */
  consult_only?: boolean;
};

export type CrmStage = {
  id: number;
  name: string;
  /** How the sweep treats open deals in this stage. */
  treat_as: "new" | "follow_up" | "booked" | "ignore";
};

export type MessagingSettings = {
  business_name: string;
  /** The person replies are written as (signs off). */
  sender_name: string;
  timezone: string; // IANA, e.g. Australia/Melbourne
  /** Label required by Founding doc 3 for anything sent on someone's behalf. */
  assistant_label: string;
  /** How the business writes to clients: tone, structure, banned words, worked examples. */
  voice: string;
  /** Prices the business actually quotes. Plain text; the brain reads it. */
  price_book: string;
  /** Extra learned rules in plain text (things that can't be simple conditions). */
  guidance: string;
  artists: Artist[];
  styles: StyleRoute[];
  /** Words that must never appear in a draft (hard rule). */
  banned_words: string[];
  /** Subject line for email replies. */
  email_subject: string;
  crm: {
    provider: "pipedrive";
    /** 0 = not set (validateSettings flags it). */
    pipeline_id: number;
    stages: CrmStage[];
    /** Hours without activity before a follow-up deal counts as gone quiet. */
    quiet_after_hours: number;
    /** Deals whose contact has one of these names are skipped (e.g. staff test entries). */
    skip_contact_names: string[];
    /** Activity subject prefix the SMS integration logs for an inbound text. */
    sms_inbound_prefix: string;
    /** Activity subject prefix the SMS integration logs for an outbound text. */
    sms_outbound_prefix: string;
    /** Regex (case-insensitive) that marks a deal note as a chatbot transcript. */
    chatbot_note_pattern: string;
  };
  slots: {
    /** How many dates to offer. */
    offer_count: number;
    /** How far ahead to look for dates. */
    lookahead_days: number;
  };
};

export const DEFAULT_SETTINGS: MessagingSettings = {
  business_name: "",
  sender_name: "",
  timezone: "Australia/Melbourne",
  assistant_label: "Sent by our assistant",
  voice: "",
  price_book: "",
  guidance: "",
  artists: [],
  styles: [],
  banned_words: [],
  email_subject: "Enquiry",
  crm: {
    provider: "pipedrive",
    pipeline_id: 0,
    stages: [],
    quiet_after_hours: 48,
    skip_contact_names: [],
    sms_inbound_prefix: "Received SMS from",
    sms_outbound_prefix: "SMS Sent to",
    chatbot_note_pattern: "chat|bot",
  },
  slots: { offer_count: 3, lookahead_days: 42 },
};

export type Bucket = "unreplied" | "new" | "quiet";

export type OfferedSlot = { artist: string; starts_at: string /* ISO with offset */ };

/** What the brain proposes for one client. Stored as actions.payload (kind 'draft_reply'). */
export type DraftPayload = {
  job_id: string;
  person_id: string | null;
  conversation_id: string | null;
  client_name: string;
  bucket: Bucket;
  /** One line: what the client is waiting for. */
  waiting_for: string;
  channel: "sms" | "email";
  /** Email only. */
  subject?: string;
  body: string;
  style?: string | null;
  artist?: string | null;
  price?: string | null;
  price_confidence?: "confident" | "rough" | "guess" | null;
  slots: OfferedSlot[];
  /** Why this artist/dates/price, for the person approving. Never sent. */
  rationale: string;
  /** Things the approver must do or check themselves. Never sent. */
  flags: string[];
  /** Short quote from the enquiry, for context on screen. */
  enquiry_excerpt: string;
  contact: { email: string | null; phone: string | null; preferred: "sms" | "email" | null };
  /** Null when the text came from a number with no CRM deal (nothing to save the note to). */
  crm: { provider: "pipedrive"; deal_id: number; url: string | null; status?: "open" | "won" | "lost"; stage_name?: string | null } | null;
};

/** actions.edited_payload when a person changes a draft before approving. */
export type DraftEdit = { body: string; subject?: string };
