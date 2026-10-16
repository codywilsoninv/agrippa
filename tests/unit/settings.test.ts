// Settings merge/validation and CRM-note helpers. Pure functions only.
// Run: npm run test:unit

import { test } from "node:test";
import assert from "node:assert/strict";
import { DRAFT_NOTE_RE, draftNoteHeading, mergeSettings, validateSettings } from "../../src/modules/messaging/settings.ts";
import { pipedriveTime, smsDirection, textToNoteHtml } from "../../src/modules/messaging/pipedrive.ts";
import { DEFAULT_SETTINGS } from "../../src/modules/messaging/types.ts";

test("mergeSettings: defaults fill gaps, nested crm/slots merge, bad shapes tolerated", () => {
  const s = mergeSettings({ business_name: "Studio", crm: { pipeline_id: 7 }, artists: "nope" });
  assert.equal(s.business_name, "Studio");
  assert.equal(s.crm.pipeline_id, 7);
  assert.equal(s.crm.sms_inbound_prefix, "Received SMS from");
  assert.equal(s.email_subject, "Enquiry");
  assert.deepEqual(s.artists, []);
  assert.equal(mergeSettings(null).timezone, DEFAULT_SETTINGS.timezone);
});

test("validateSettings: flags a missing pipeline id (default 0) and empty essentials", () => {
  const problems = validateSettings(mergeSettings({}));
  assert.ok(problems.some((p) => /pipeline id/i.test(p)));
  assert.ok(problems.some((p) => /voice/i.test(p)));
  assert.ok(problems.some((p) => /roster/i.test(p)));
});

test("validateSettings: a complete settings object passes", () => {
  const s = mergeSettings({
    business_name: "Studio",
    sender_name: "Sam",
    voice: "short and warm",
    artists: [{ name: "Alice", active: true, in_house: true, day_start: "11:00" }],
    styles: [{ name: "fine line", description: "thin", ranks: { Alice: 1 } }],
    crm: { pipeline_id: 1, stages: [{ id: 1, name: "New", treat_as: "new" }] },
  });
  assert.deepEqual(validateSettings(s), []);
});

test("validateSettings: bad chatbot regex is reported", () => {
  const s = mergeSettings({ crm: { chatbot_note_pattern: "(" } });
  assert.ok(validateSettings(s).some((p) => /chatbot_note_pattern/.test(p)));
});

test("draftNoteHeading carries the Agrippa label and matches the own-note filter (old and new)", () => {
  assert.equal(draftNoteHeading("sms"), "DRAFT — SMS (drafted by Agrippa):");
  assert.equal(draftNoteHeading("email", "Enquiry"), "DRAFT — EMAIL, Enquiry (drafted by Agrippa):");
  assert.ok(DRAFT_NOTE_RE.test(draftNoteHeading("sms")));
  assert.ok(DRAFT_NOTE_RE.test("DRAFT — SMS:\nold style"));
  assert.ok(DRAFT_NOTE_RE.test("DRAFT - EMAIL (Tattoo Enquiry):"));
  assert.ok(!DRAFT_NOTE_RE.test("Chatbot conversation summary"));
});

test("textToNoteHtml escapes and paragraphs", () => {
  assert.equal(textToNoteHtml("Hey <Sam> & co\nline two\n\nBye"), "<p>Hey &lt;Sam&gt; &amp; co<br>line two</p><p>Bye</p>");
});

test("smsDirection uses the configured prefixes, case-insensitively", () => {
  const prefixes = { sms_inbound_prefix: "Received SMS from", sms_outbound_prefix: "SMS Sent to" };
  assert.equal(smsDirection({ subject: "Received SMS from Sam" }, prefixes), "inbound");
  assert.equal(smsDirection({ subject: "sms sent to Sam" }, prefixes), "outbound");
  assert.equal(smsDirection({ subject: "Call" }, prefixes), null);
  const custom = { sms_inbound_prefix: "Text in:", sms_outbound_prefix: "Text out:" };
  assert.equal(smsDirection({ subject: "Text in: Sam" }, custom), "inbound");
  assert.equal(smsDirection({ subject: "Received SMS from Sam" }, custom), null);
});

test("pipedriveTime parses v1 and v2 timestamps as UTC", () => {
  assert.equal(pipedriveTime("2026-10-16 03:04:05").toISOString(), "2026-10-16T03:04:05.000Z");
  assert.equal(pipedriveTime("2026-10-16T03:04:05Z").toISOString(), "2026-10-16T03:04:05.000Z");
  assert.equal(pipedriveTime("2026-10-16").toISOString(), "2026-10-16T00:00:00.000Z");
});
