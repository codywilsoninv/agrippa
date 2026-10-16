// Email parsing, quote stripping, thread keys, automated-sender detection and
// cross-channel "waiting on us". Pure functions only. Run: npm run test:unit

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEncodedWords, isAutomatedSender, normaliseSubject, parseAddressList, parseHeaders, parseMail, stripQuotedReply, threadKey } from "../../src/modules/messaging/mail.ts";
import { groupEmails, waitingOnUs } from "../../src/modules/messaging/texts.ts";
import { DEFAULT_SETTINGS } from "../../src/modules/messaging/types.ts";
import type { EmailRecord } from "../../src/modules/messaging/gmail.ts";
import type { SmsRecord } from "../../src/modules/messaging/clicksend.ts";

const SKIP = DEFAULT_SETTINGS.crm.email_skip_patterns;

test("parseHeaders unfolds and lower-cases", () => {
  const h = parseHeaders("Subject: Re: Tattoo\r\n enquiry\r\nFrom: Sam <sam@example.com>\r\nX-Two: a\r\nX-Two: b\r\n\r\nbody");
  assert.equal(h.subject, "Re: Tattoo enquiry");
  assert.equal(h.from, "Sam <sam@example.com>");
  assert.equal(h["x-two"], "a, b");
});

test("encoded words and address lists", () => {
  assert.equal(decodeEncodedWords("=?UTF-8?B?U8OhbQ==?= here"), "Sám here");
  assert.equal(decodeEncodedWords("=?iso-8859-1?Q?caf=E9?="), "café");
  const list = parseAddressList('"Wilson, Sam" <Sam@Example.com>, bookings@studio.com, =?UTF-8?Q?J=C3=B6rg?= <j@x.de>');
  assert.deepEqual(list, [
    { name: "Wilson, Sam", address: "sam@example.com" },
    { name: null, address: "bookings@studio.com" },
    { name: "Jörg", address: "j@x.de" },
  ]);
});

test("parseMail: multipart/alternative prefers text/plain, decodes quoted-printable", () => {
  const raw = [
    "From: Sam <sam@example.com>",
    "To: bookings@studio.com",
    "Subject: Re: Tattoo Enquiry",
    "Message-ID: <abc@example.com>",
    "In-Reply-To: <root@studio.com>",
    'Content-Type: multipart/alternative; boundary="XYZ"',
    "",
    "--XYZ",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Yes please, Wed works. Caf=C3=A9 after?",
    "",
    "On Tue, 14 Oct 2026 at 10:02, Umbra <bookings@studio.com> wrote:",
    "> We can do Wed 21 Oct at 11am.",
    "--XYZ",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Yes please</p>",
    "--XYZ--",
  ].join("\r\n");
  const m = parseMail(raw);
  assert.equal(m.text, "Yes please, Wed works. Café after?");
  assert.equal(threadKey(m.headers), "<root@studio.com>");
});

test("parseMail: base64 html-only falls back to stripped html", () => {
  const html = Buffer.from("<div>Hi there<br>Thanks</div><style>p{}</style>").toString("base64");
  const raw = ["From: a@b.com", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", html].join("\r\n");
  assert.equal(parseMail(raw).text, "Hi there\nThanks");
});

test("stripQuotedReply: cuts at common markers and drops > lines, caps length", () => {
  assert.equal(stripQuotedReply("Sounds good\n\n-----Original Message-----\nFrom: x\nblah"), "Sounds good");
  assert.equal(stripQuotedReply("Sounds good\n\nOn Mon, 13 Oct 2026 at 09:00, Sam\n<sam@x.com> wrote:\n> old"), "Sounds good");
  assert.equal(stripQuotedReply("Ok\n\nSent from my iPhone"), "Ok");
  assert.equal(stripQuotedReply("Ok\n-- \nSam\nArtist"), "Ok");
  assert.equal(stripQuotedReply("> quoted\nreal line\n> more"), "real line");
  assert.ok(stripQuotedReply("x".repeat(5000)).length <= 4001);
});

test("threadKey: References root, then In-Reply-To, then normalised subject", () => {
  assert.equal(threadKey({ references: "<a@x> <b@x>", "in-reply-to": "<b@x>" }), "<a@x>");
  assert.equal(threadKey({ "in-reply-to": "<b@x>" }), "<b@x>");
  assert.equal(threadKey({ subject: "RE: Fwd:  Tattoo Enquiry " }), "subject:tattoo enquiry");
  assert.equal(normaliseSubject("Re: re: Hello"), "hello");
});

test("isAutomatedSender: default patterns and headers", () => {
  assert.equal(isAutomatedSender("noreply@acuityscheduling.com", {}, SKIP), true);
  assert.equal(isAutomatedSender("no-reply@jotform.com", {}, SKIP), true);
  assert.equal(isAutomatedSender("mailer-daemon@googlemail.com", {}, SKIP), true);
  assert.equal(isAutomatedSender("calendar-notification@google.com", {}, SKIP), true);
  assert.equal(isAutomatedSender("sam@gmail.com", {}, SKIP), false);
  assert.equal(isAutomatedSender("sam@gmail.com", { "auto-submitted": "auto-replied" }, SKIP), true);
  assert.equal(isAutomatedSender("sam@gmail.com", { precedence: "bulk" }, SKIP), true);
  assert.equal(isAutomatedSender("sam@gmail.com", { "list-unsubscribe": "<x>" }, SKIP), true);
  assert.equal(isAutomatedSender("sam@gmail.com", {}, ["("]), false); // bad pattern ignored
});

function mail(id: string, direction: "inbound" | "outbound", other: string, at: string, body = "hi", automated = false): EmailRecord {
  const own = "bookings@studio.com";
  return direction === "inbound"
    ? { id, direction, from: other, to: [own], subject: "s", body, at, threadKey: "k", automated }
    : { id, direction, from: own, to: [other], subject: "s", body, at, threadKey: "k", automated };
}

test("groupEmails: per address, automated dropped, unreplied when last is inbound", () => {
  const threads = groupEmails(
    [
      mail("1", "inbound", "sam@x.com", "2026-10-10T00:00:00Z"),
      mail("2", "outbound", "sam@x.com", "2026-10-11T00:00:00Z"),
      mail("3", "inbound", "sam@x.com", "2026-10-12T00:00:00Z"),
      mail("3", "inbound", "sam@x.com", "2026-10-12T00:00:00Z"),
      mail("4", "inbound", "noreply@acuityscheduling.com", "2026-10-12T00:00:00Z", "booking", true),
      mail("5", "outbound", "amy@x.com", "2026-10-12T00:00:00Z"),
    ],
    "bookings@studio.com",
  );
  const by = Object.fromEntries(threads.map((t) => [t.address, t]));
  assert.deepEqual(Object.keys(by).sort(), ["amy@x.com", "sam@x.com"]);
  assert.equal(by["sam@x.com"].emails.length, 3);
  assert.equal(by["sam@x.com"].unreplied, true);
  assert.equal(by["amy@x.com"].unreplied, false);
});

function sms(id: string, direction: "inbound" | "outbound", at: string): SmsRecord {
  return { id, direction, from: "+61400000001", to: "+61400000002", body: "x", at };
}

test("waitingOnUs: judged across channels; draft follows the latest inbound channel", () => {
  // Client texted, we replied by email afterwards: not waiting.
  let w = waitingOnUs([sms("a", "inbound", "2026-10-10T00:00:00Z")], [mail("b", "outbound", "sam@x.com", "2026-10-11T00:00:00Z")]);
  assert.equal(w.unreplied, false);
  // We texted, client replied by email: waiting, and the draft should be an email.
  w = waitingOnUs([sms("a", "outbound", "2026-10-10T00:00:00Z")], [mail("b", "inbound", "sam@x.com", "2026-10-11T00:00:00Z")]);
  assert.equal(w.unreplied, true);
  assert.equal(w.lastInboundChannel, "email");
  assert.equal(w.lastAt, "2026-10-11T00:00:00.000Z");
  assert.equal(waitingOnUs([], []).unreplied, false);
});
