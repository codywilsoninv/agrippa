// Messaging module: settings shape and validation. PURE (type imports only),
// so the UI, the sweep and the unit tests share one source of truth.

import { isKnownCountry, toE164 } from "./phone.ts";
import { DEFAULT_SETTINGS, type MessagingSettings } from "./types.ts";

/** Whatever is in workspace_modules.settings, merged over the defaults so it always has a shape. */
export function mergeSettings(raw: unknown): MessagingSettings {
  const stored = (raw && typeof raw === "object" ? raw : {}) as Partial<MessagingSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    crm: {
      ...DEFAULT_SETTINGS.crm,
      ...(stored.crm ?? {}),
      ignore_phone_numbers: Array.isArray(stored.crm?.ignore_phone_numbers) ? stored.crm.ignore_phone_numbers : [],
      email_skip_patterns: Array.isArray(stored.crm?.email_skip_patterns) ? stored.crm.email_skip_patterns : DEFAULT_SETTINGS.crm.email_skip_patterns,
    },
    slots: { ...DEFAULT_SETTINGS.slots, ...(stored.slots ?? {}) },
    artists: Array.isArray(stored.artists) ? stored.artists : [],
    styles: Array.isArray(stored.styles) ? stored.styles : [],
    banned_words: Array.isArray(stored.banned_words) ? stored.banned_words : [],
  };
}

/** Problems that stop a sweep. Empty list = good to go. For the settings screen too. */
export function validateSettings(s: MessagingSettings): string[] {
  const problems: string[] = [];
  if (!s.business_name.trim()) problems.push("Business name is empty.");
  if (!s.sender_name.trim()) problems.push("Sender name (who signs off) is empty.");
  if (!s.timezone.trim() || !isValidTimezone(s.timezone)) problems.push("Timezone is missing or not a valid IANA zone.");
  if (!s.voice.trim()) problems.push("Voice is empty: the drafts would have no tone to follow.");
  if (!s.email_subject.trim()) problems.push("Email subject is empty.");
  if (!isKnownCountry(s.country)) problems.push(`Country "${s.country}" isn't one Agrippa knows how to read phone numbers for (AU, NZ, GB, US).`);
  for (const n of s.crm.ignore_phone_numbers) if (!toE164(n, s.country)) problems.push(`ignore_phone_numbers: "${n}" isn't a phone number.`);
  if (s.artists.length === 0) problems.push("No artists on the roster.");
  if (!s.artists.some((a) => a.active && a.in_house)) problems.push("Nobody on the roster is both active and in-house, so no one can be offered.");
  for (const a of s.artists) {
    if (!a.name.trim()) problems.push("An artist has no name.");
    if (!/^\d{1,2}:\d{2}$/.test(a.day_start ?? "")) problems.push(`${a.name || "An artist"}: day_start must be HH:MM.`);
    if ((a.acuity_calendar_id && !a.acuity_appointment_type_id) || (!a.acuity_calendar_id && a.acuity_appointment_type_id))
      problems.push(`${a.name}: needs both an Acuity calendar id and appointment type id, or neither.`);
  }
  if (s.styles.length === 0) problems.push("No styles defined, so enquiries can't be routed.");
  const names = new Set(s.artists.map((a) => a.name.trim().toLowerCase()));
  for (const st of s.styles) {
    for (const key of Object.keys(st.ranks)) {
      if (!names.has(key.trim().toLowerCase())) problems.push(`Style "${st.name}" ranks "${key}", who is not on the roster.`);
    }
  }
  if (!(Number.isInteger(s.crm.pipeline_id) && s.crm.pipeline_id > 0)) problems.push("CRM pipeline id is missing.");
  if (s.crm.stages.length === 0) problems.push("No CRM stages mapped: the sweep can't tell new enquiries from booked ones.");
  if (!(s.crm.quiet_after_hours > 0)) problems.push("quiet_after_hours must be greater than 0.");
  if (!s.crm.sms_inbound_prefix.trim() || !s.crm.sms_outbound_prefix.trim()) problems.push("SMS activity subject prefixes are empty.");
  if (!isValidRegex(s.crm.chatbot_note_pattern)) problems.push("chatbot_note_pattern is not a valid regular expression.");
  for (const p of s.crm.email_skip_patterns) if (!isValidRegex(p)) problems.push(`email_skip_patterns: "${p}" is not a valid regular expression.`);
  if (!(s.slots.offer_count > 0)) problems.push("slots.offer_count must be at least 1.");
  if (!(s.slots.lookahead_days > 0)) problems.push("slots.lookahead_days must be at least 1.");
  return problems;
}

/** Founding doc 3: anything that leaves Agrippa on someone's behalf says so. */
export function draftNoteHeading(channel: "sms" | "email", subject?: string): string {
  return channel === "sms" ? "DRAFT — SMS (drafted by Agrippa):" : `DRAFT — EMAIL, ${subject ?? ""} (drafted by Agrippa):`;
}

/** Our own CRM notes, old header ("DRAFT — SMS:") and new; they are drafts, not messages. */
export const DRAFT_NOTE_RE = /^DRAFT\s*[—–-]/i;

function isValidRegex(re: string): boolean {
  try {
    new RegExp(re, "i");
    return true;
  } catch {
    return false;
  }
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
