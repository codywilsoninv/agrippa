// Messaging module: email parsing helpers. PURE, no imports, so they unit-test
// with plain `node --test`. Used by gmail.ts on raw RFC 822 sources.
//
// Deliberately small: we need the plain text a person typed, who it is from
// and to, when, and enough to tie replies into one thread. Attachments, HTML
// layout and calendar parts are ignored.

export type Address = { name: string | null; address: string };

export type ParsedMail = {
  headers: Record<string, string>;
  text: string;
};

const BODY_CAP = 4000;

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/** Lower-cased header name → unfolded value. Repeated headers are joined with ", ". */
export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  let key: string | null = null;
  for (const line of lines) {
    if (line === "") break;
    if (/^[ \t]/.test(line) && key) {
      out[key] += " " + line.trim();
      continue;
    }
    const m = line.match(/^([!-9;-~]+):\s*(.*)$/);
    if (!m) continue;
    key = m[1].toLowerCase();
    out[key] = key in out ? `${out[key]}, ${m[2]}` : m[2];
  }
  return out;
}

/** RFC 2047 encoded words ("=?utf-8?B?...?=") in subjects and names. */
export function decodeEncodedWords(s: string): string {
  return s
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, enc: string, data: string) => {
      const bytes = enc.toUpperCase() === "B" ? Buffer.from(data, "base64") : qpDecode(data.replace(/_/g, " "));
      return decodeBytes(bytes, charset);
    });
}

export function parseAddressList(header: string | undefined): Address[] {
  if (!header) return [];
  const out: Address[] = [];
  // Split on commas outside quotes and angle brackets.
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") depth++;
    else if (!quoted && ch === ">") depth--;
    if (ch === "," && !quoted && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  for (const p of parts) {
    const t = decodeEncodedWords(p.trim());
    if (!t) continue;
    const m = t.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/);
    if (m) out.push({ name: m[1]?.trim() || null, address: m[2].trim().toLowerCase() });
    else if (/@/.test(t)) out.push({ name: null, address: t.replace(/^<|>$/g, "").trim().toLowerCase() });
  }
  return out;
}

export function normaliseEmail(address: string | null | undefined): string | null {
  const a = (address ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) ? a : null;
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function qpDecode(s: string): Buffer {
  const cleaned = s.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
      bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(cleaned.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeBytes(bytes: Buffer, charset: string | undefined): string {
  const cs = (charset ?? "utf-8").toLowerCase().replace(/"/g, "");
  try {
    return new TextDecoder(cs === "us-ascii" ? "utf-8" : cs).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function contentType(headers: Record<string, string>): { type: string; params: Record<string, string> } {
  const raw = headers["content-type"] ?? "text/plain";
  const [type, ...rest] = raw.split(";");
  const params: Record<string, string> = {};
  for (const r of rest) {
    const m = r.trim().match(/^([^=]+)=("?)(.*?)\2$/);
    if (m) params[m[1].trim().toLowerCase()] = m[3];
  }
  return { type: type.trim().toLowerCase(), params };
}

function decodeBody(body: string, headers: Record<string, string>, charset: string | undefined): string {
  const enc = (headers["content-transfer-encoding"] ?? "7bit").trim().toLowerCase();
  if (enc === "base64") return decodeBytes(Buffer.from(body.replace(/\s+/g, ""), "base64"), charset);
  if (enc === "quoted-printable") return decodeBytes(qpDecode(body), charset);
  return decodeBytes(Buffer.from(body, "latin1"), charset);
}

/** Crude but adequate: HTML → readable text when no text/plain part exists. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Part = { plain?: string; html?: string };

function parsePart(raw: string): Part {
  const idx = raw.search(/\r?\n\r?\n/);
  const headRaw = idx >= 0 ? raw.slice(0, idx) : raw;
  const body = idx >= 0 ? raw.slice(idx).replace(/^\r?\n\r?\n/, "") : "";
  const headers = parseHeaders(headRaw);
  const { type, params } = contentType(headers);

  if (type.startsWith("multipart/") && params.boundary) {
    const pieces = body.split(new RegExp(`(?:^|\\r?\\n)--${escapeRe(params.boundary)}(?:--)?(?:\\r?\\n|$)`));
    const merged: Part = {};
    for (const piece of pieces.slice(1)) {
      if (!piece.trim()) continue;
      const sub = parsePart(piece);
      // First plain wins; keep looking for html only as a fallback.
      if (sub.plain && !merged.plain) merged.plain = sub.plain;
      if (sub.html && !merged.html) merged.html = sub.html;
      if (merged.plain) break;
    }
    return merged;
  }
  if (type === "text/plain") return { plain: decodeBody(body, headers, params.charset) };
  if (type === "text/html") return { html: decodeBody(body, headers, params.charset) };
  if (type === "message/rfc822") return parsePart(body);
  return {};
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Headers plus the plain text a person wrote (quotes and signatures stripped, capped). */
export function parseMail(rawSource: string): ParsedMail {
  const headers = parseHeaders(rawSource);
  const part = parsePart(rawSource);
  const text = part.plain ?? (part.html ? htmlToText(part.html) : "");
  return { headers, text: stripQuotedReply(text) };
}

// ---------------------------------------------------------------------------
// Quoted replies and signatures
// ---------------------------------------------------------------------------

const REPLY_MARKERS: RegExp[] = [
  /^On .{0,200}?wrote:\s*$/m, // "On Tue, 14 Oct 2026 at 10:02, Sam <sam@x> wrote:" (may wrap onto two lines)
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/im,
  /^From:\s.+\r?\n(?:Sent|Date):\s.+/m, // Outlook-style header block
  /^_{5,}\s*$/m,
  /^Sent from my (iPhone|iPad|Samsung|Galaxy|Android|mobile)/im,
  /^Get Outlook for (iOS|Android)/im,
  /^-- \s*$/m, // signature delimiter
];

export function stripQuotedReply(text: string): string {
  let t = text.replace(/\r\n/g, "\n");
  // The "On ... wrote:" marker often wraps; join its lines before matching.
  t = t.replace(/^(On [^\n]{0,120})\n([^\n]{0,120}wrote:)\s*$/m, "$1 $2");
  let cut = t.length;
  for (const re of REPLY_MARKERS) {
    const m = t.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  t = t.slice(0, cut);
  // Drop trailing quoted lines (">") and whitespace.
  const lines = t.split("\n");
  while (lines.length && (/^\s*>/.test(lines[lines.length - 1]) || lines[lines.length - 1].trim() === "")) lines.pop();
  t = lines.filter((l) => !/^\s*>/.test(l)).join("\n").trim();
  return t.length > BODY_CAP ? t.slice(0, BODY_CAP) + "…" : t;
}

// ---------------------------------------------------------------------------
// Threads and senders
// ---------------------------------------------------------------------------

/** Root of the conversation: first References id, else In-Reply-To, else the subject without Re:/Fwd:. */
export function threadKey(headers: Record<string, string>): string {
  const refs = (headers["references"] ?? "").match(/<[^>]+>/g);
  if (refs && refs.length > 0) return refs[0];
  const irt = (headers["in-reply-to"] ?? "").match(/<[^>]+>/);
  if (irt) return irt[0];
  return "subject:" + normaliseSubject(headers["subject"] ?? "");
}

export function normaliseSubject(subject: string): string {
  return decodeEncodedWords(subject)
    .replace(/^\s*((re|fw|fwd|aw|tr)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** A machine, not a person: matched address pattern, or auto-submitted / bulk headers. */
export function isAutomatedSender(address: string, headers: Record<string, string>, patterns: string[]): boolean {
  const a = address.toLowerCase();
  for (const p of patterns) {
    try {
      if (new RegExp(p, "i").test(a)) return true;
    } catch {
      // A bad pattern in settings is reported by validateSettings; ignore it here.
    }
  }
  const auto = (headers["auto-submitted"] ?? "").toLowerCase();
  if (auto && auto !== "no") return true;
  const prec = (headers["precedence"] ?? "").toLowerCase();
  if (prec === "bulk" || prec === "list" || prec === "junk") return true;
  if (headers["list-unsubscribe"] || headers["list-id"]) return true;
  return false;
}
