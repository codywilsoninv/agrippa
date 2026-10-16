import "server-only";
import { ImapFlow } from "imapflow";
import { isAutomatedSender, normaliseEmail, parseAddressList, parseMail, threadKey } from "./mail";

// Gmail over IMAP with a Google app password (OAuth is ruled out for now by
// Google's restricted-scope review). READ ONLY: mailboxes are opened read-only
// (EXAMINE), nothing is flagged, appended, moved or deleted, and nothing is
// ever sent from here. Sending email is a v0.2 approve-tier, labelled action.

type Secrets = { email: string; app_password: string };

const HOST = "imap.gmail.com";
const PORT = 993;
const MAX_PER_MAILBOX = 200;
const SOURCE_CAP_BYTES = 96 * 1024; // enough for the text a person typed; attachments are cut off
const CONNECT_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 60_000;

export type EmailRecord = {
  id: string; // Message-ID (or "<uid>@<mailbox>" when a message has none)
  direction: "inbound" | "outbound";
  from: string;
  to: string[];
  subject: string;
  body: string;
  at: string; // ISO
  threadKey: string;
  /** Headers say a machine sent it (or the address matches a skip pattern). */
  automated: boolean;
};

function client(secrets: Secrets): ImapFlow {
  if (!secrets.email || !secrets.app_password) throw new Error("Gmail address or app password is missing");
  return new ImapFlow({
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user: secrets.email, pass: secrets.app_password.replace(/\s+/g, "") },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    clientInfo: { name: "Agrippa", vendor: "Agrippa" },
  });
}

/** Credentials check for the connections screen. */
export async function testGmail(secrets: Secrets): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
  let c: ImapFlow | null = null;
  try {
    c = client(secrets);
    await c.connect();
    return { ok: true, account: secrets.email.toLowerCase() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (/AUTHENTICATIONFAILED|Invalid credentials|auth/i.test(msg)) {
      return { ok: false, error: "Google rejected the address or app password. Check 2-Step Verification is on and the app password was created for this account." };
    }
    return { ok: false, error: msg ? `couldn't reach Gmail: ${msg.slice(0, 120)}` : "couldn't reach Gmail" };
  } finally {
    if (c) await c.logout().catch(() => undefined);
  }
}

/**
 * Mail in INBOX and the Sent folder since the date: headers plus the plain
 * text, quotes stripped. Capped per mailbox and by source size so a whole read
 * fits a serverless window.
 */
export async function readMail(secrets: Secrets, since: Date, skipPatterns: string[]): Promise<EmailRecord[]> {
  const ownAddress = secrets.email.toLowerCase();
  const c = client(secrets);
  await c.connect();
  try {
    const sentPath = await findSentMailbox(c);
    const inbox = await readMailbox(c, "INBOX", since, ownAddress, skipPatterns, "inbound");
    const sent = sentPath ? await readMailbox(c, sentPath, since, ownAddress, skipPatterns, "outbound") : [];
    // Dedupe by Message-ID (a sent reply to ourselves could show in both).
    const seen = new Set<string>();
    return [...inbox, ...sent].filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  } finally {
    await c.logout().catch(() => undefined);
  }
}

/** The \Sent special-use folder, found by flag rather than by its localised name. */
async function findSentMailbox(c: ImapFlow): Promise<string | null> {
  const boxes = await c.list();
  const sent = boxes.find((b) => b.specialUse === "\\Sent");
  return sent?.path ?? boxes.find((b) => /sent/i.test(b.name))?.path ?? null;
}

async function readMailbox(
  c: ImapFlow,
  path: string,
  since: Date,
  ownAddress: string,
  skipPatterns: string[],
  defaultDirection: "inbound" | "outbound",
): Promise<EmailRecord[]> {
  const lock = await c.getMailboxLock(path, { readOnly: true });
  try {
    const found = await c.search({ since }, { uid: true });
    const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a).slice(0, MAX_PER_MAILBOX);
    if (uids.length === 0) return [];
    const out: EmailRecord[] = [];
    // Full source (capped) rather than per-part downloads: one round trip per
    // page, and the MIME parsing is pure code we can test.
    for await (const msg of c.fetch(uids, { uid: true, internalDate: true, source: { maxLength: SOURCE_CAP_BYTES } }, { uid: true })) {
      if (!msg.source) continue;
      const rec = toRecord(msg.source.toString("latin1"), msg.uid, path, msg.internalDate, ownAddress, skipPatterns, defaultDirection);
      if (rec) out.push(rec);
    }
    return out;
  } finally {
    lock.release();
  }
}

function toRecord(
  raw: string,
  uid: number,
  path: string,
  internalDate: Date | string | undefined,
  ownAddress: string,
  skipPatterns: string[],
  defaultDirection: "inbound" | "outbound",
): EmailRecord | null {
  const { headers, text } = parseMail(raw);
  const from = parseAddressList(headers["from"])[0];
  const fromAddress = normaliseEmail(from?.address);
  if (!fromAddress) return null;
  const to = parseAddressList(headers["to"])
    .map((a) => normaliseEmail(a.address))
    .filter((a): a is string => a !== null);
  const direction: "inbound" | "outbound" = fromAddress === ownAddress ? "outbound" : defaultDirection;
  const dateHeader = headers["date"] ? new Date(headers["date"]) : null;
  const at = dateHeader && !Number.isNaN(dateHeader.getTime()) ? dateHeader : internalDate ? new Date(internalDate) : new Date();
  const id = (headers["message-id"] ?? "").match(/<[^>]+>/)?.[0] ?? `<${uid}@${path}>`;
  return {
    id,
    direction,
    from: fromAddress,
    to,
    subject: (headers["subject"] ?? "").trim(),
    body: text,
    at: at.toISOString(),
    threadKey: threadKey(headers),
    automated: direction === "inbound" && isAutomatedSender(fromAddress, headers, skipPatterns),
  };
}
