// Small display helpers shared by the Messaging screens. No data access here.
import type { Bucket } from "@/modules/messaging/types";

export function relativeAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.round(days / 7);
  return `${weeks}w`;
}

export function longAge(iso: string | null | undefined): string {
  const short = relativeAge(iso);
  if (!short) return "";
  const n = parseInt(short, 10);
  const unit = short.slice(-1);
  const words: Record<string, [string, string]> = {
    m: ["minute", "minutes"],
    h: ["hour", "hours"],
    d: ["day", "days"],
    w: ["week", "weeks"],
  };
  const [one, many] = words[unit] ?? ["", ""];
  return `${n} ${n === 1 ? one : many}`;
}

export const BUCKET_LABEL: Record<Bucket, string> = {
  unreplied: "Unreplied",
  new: "New enquiries",
  quiet: "Gone quiet",
};

export const BUCKET_SINGULAR: Record<Bucket, string> = {
  unreplied: "Unreplied",
  new: "New enquiry",
  quiet: "Gone quiet",
};

export const BUCKET_ORDER: Bucket[] = ["unreplied", "new", "quiet"];

export function channelLabel(channel: string | null | undefined): string {
  switch (channel) {
    case "sms":
      return "SMS";
    case "email":
      return "Email";
    case "chat":
      return "Chat";
    case "form":
      return "Web form";
    case "note":
      return "Note";
    default:
      return channel ? channel.charAt(0).toUpperCase() + channel.slice(1) : "";
  }
}

export function formatDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-AU", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(d);
  } catch {
    return d.toLocaleString("en-AU");
  }
}

export function finalContactLine(contact: { email: string | null; phone: string | null; preferred: "sms" | "email" | null }): string {
  const pref = contact.preferred === "sms" ? "Prefers text" : contact.preferred === "email" ? "Prefers email" : "";
  const detail = contact.preferred === "sms" ? contact.phone : contact.preferred === "email" ? contact.email : contact.email ?? contact.phone;
  return [pref, detail].filter(Boolean).join(" · ") || "No contact details";
}

export function truncate(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}

/** Bucket the size of a text edit by how much of the original changed. */
export function editSize(original: string, edited: string): "none" | "small" | "medium" | "large" {
  if (original === edited) return "none";
  let start = 0;
  const max = Math.min(original.length, edited.length);
  while (start < max && original[start] === edited[start]) start++;
  let end = 0;
  while (end < max - start && original[original.length - 1 - end] === edited[edited.length - 1 - end]) end++;
  const changed = Math.max(original.length - start - end, edited.length - start - end);
  const ratio = changed / Math.max(1, original.length);
  if (ratio <= 0.1) return "small";
  if (ratio <= 0.35) return "medium";
  return "large";
}
