// Email parsing, quote stripping, thread keys, automated-sender detection and
// cross-channel "waiting on us". Pure functions only. Run: npm run test:unit

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEncodedWords, isAutomatedSender, normaliseSubject, parseAddressList, parseHeaders, parseMail, stripQuotedReply, threadKey } from "../../src/modules/messaging/mail.ts";
import { DEFAULT_SETTINGS } from "../../src/modules/messaging/types.ts";

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
