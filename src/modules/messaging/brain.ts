// Messaging module: the AI layer ("brain"). Two model calls per client:
//   1. classify (quick model): what style, named artist, preferred days, etc.
//   2. draft (default model): the reply, as structured output.
// Routing and slot picking happen in code between the two (routing.ts), and
// the hard rules (rules.ts) run on the result before anything is proposed.
//
// "Own the middle, rent the model": the model name is one config value here,
// the instructions live in brain/instructions.md, versioned with the repo.
// Client content goes to the model and nowhere else: never into logs or telemetry.

import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bucket, DraftPayload, MessagingSettings, OfferedSlot, Weekday } from "./types";
import { MODULE_ID, MODULE_VERSION } from "./types";
import { checkDraft, type RuleFailure } from "./rules";
import { formatSlot } from "./routing";
import { emitTelemetry } from "@/lib/telemetry";

export const MODELS = {
  quick: process.env.MESSAGING_MODEL_QUICK || "claude-haiku-5-5",
  default: process.env.MESSAGING_MODEL_DEFAULT || "claude-sonnet-5-5",
} as const;

export const INSTRUCTIONS_PATH = "src/modules/messaging/brain/instructions.md";

/** One message of the thread as the brain sees it. */
export type ThreadMessage = {
  direction: "inbound" | "outbound";
  channel: "sms" | "email" | "chat" | "form" | "note";
  author: string | null;
  body: string;
  sent_at: string; // ISO
};

export type Classification = {
  /** One of settings.styles[].name, or "unclear". */
  style: string;
  named_artist: string | null;
  preferred_weekdays: Weekday[];
  budget: string | null;
  has_reference: boolean;
  two_people: boolean;
  not_ready: boolean;
  courtesy_only: boolean;
  /** One or two sentences: what the client wants, for the approver's screen. */
  summary: string;
};

export type TokenUsage = { model: string; input_tokens: number; output_tokens: number };

export type DraftOutput = Pick<
  DraftPayload,
  "channel" | "subject" | "body" | "artist" | "price" | "price_confidence" | "waiting_for" | "rationale" | "flags"
>;

export type DraftResult =
  | { ok: true; draft: DraftOutput; usage: TokenUsage[]; attempts: number }
  | { ok: false; failures: RuleFailure[]; usage: TokenUsage[]; attempts: number };

let instructionsCache: string | null = null;

/** Read at runtime so the file is data, not a string baked into code. next.config.ts traces it into the bundle. */
export function loadInstructions(): string {
  if (instructionsCache) return instructionsCache;
  instructionsCache = readFileSync(join(process.cwd(), INSTRUCTIONS_PATH), "utf8");
  return instructionsCache;
}

function client(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic();
}

// ---------------------------------------------------------------------------
// Shared: render the thread and the business data as plain text blocks.
// ---------------------------------------------------------------------------

function renderThread(thread: ThreadMessage[], timezone: string): string {
  if (thread.length === 0) return "(no messages yet)";
  return thread
    .map((m) => {
      const who = m.direction === "inbound" ? `CLIENT${m.author ? ` (${m.author})` : ""}` : `BUSINESS${m.author ? ` (${m.author})` : ""}`;
      const when = formatSlot(m.sent_at, timezone);
      return `--- ${who} via ${m.channel}, ${when} ---\n${m.body.trim()}`;
    })
    .join("\n\n");
}

function renderRoster(settings: MessagingSettings): string {
  const routable = settings.artists.filter((a) => a.active && a.in_house);
  if (routable.length === 0) return "(nobody on the roster can be offered)";
  return routable
    .map((a) => {
      const bits = [a.name];
      if (a.must_mention) bits.push(`MUST MENTION when offered: ${a.must_mention}`);
      if (a.note) bits.push(`note: ${a.note}`);
      return "- " + bits.join(" | ");
    })
    .join("\n");
}

function renderStyles(settings: MessagingSettings): string {
  return settings.styles.map((s) => `- ${s.name}: ${s.description}${s.consult_only ? " (consult only, no quote)" : ""}`).join("\n");
}

/** Pulls a tool_use input out of a response, or throws a readable error. */
function toolInput<T>(message: Anthropic.Message, toolName: string): T {
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === toolName) return block.input as T;
  }
  throw new Error(`Model did not return structured output (${toolName}); stop_reason=${message.stop_reason}`);
}

function usageOf(message: Anthropic.Message): TokenUsage {
  return { model: message.model, input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens };
}

// ---------------------------------------------------------------------------
// Step 1: classify (quick model)
// ---------------------------------------------------------------------------

const WEEKDAY_ENUM = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export async function classifyEnquiry(
  settings: MessagingSettings,
  thread: ThreadMessage[],
): Promise<{ classification: Classification; usage: TokenUsage }> {
  const styleNames = settings.styles.map((s) => s.name);
  const artistNames = settings.artists.map((a) => a.name);

  const system = [
    "You triage customer enquiries for a business. Read the thread and extract the facts below.",
    "Pick the style only from the list given; use \"unclear\" if the thread does not make it clear.",
    "Only report a named artist if the client asked for a specific person by name (match it to the roster names if you can; otherwise give the name as written).",
    "preferred_weekdays: only days the client explicitly asked for.",
    "has_reference: true if the client attached, described or linked a design/reference, or the thread includes a description of what they want.",
    "two_people: the client is booking for two or more people.",
    "not_ready: the client said they are waiting on something before booking.",
    "courtesy_only: the latest client message is only a thank-you or sign-off that needs no reply.",
  ].join("\n");

  const user = [
    "STYLES:",
    renderStyles(settings) || "(none)",
    "",
    "ROSTER NAMES: " + (artistNames.join(", ") || "(none)"),
    "",
    "THREAD:",
    renderThread(thread, settings.timezone),
  ].join("\n");

  const message = await client().messages.create({
    model: MODELS.quick,
    max_tokens: 600,
    system,
    messages: [{ role: "user", content: user }],
    tools: [
      {
        name: "classify",
        description: "Report the facts extracted from the enquiry thread.",
        input_schema: {
          type: "object",
          properties: {
            style: { type: "string", enum: [...styleNames, "unclear"] },
            named_artist: { type: ["string", "null"] },
            preferred_weekdays: { type: "array", items: { type: "string", enum: [...WEEKDAY_ENUM] } },
            budget: { type: ["string", "null"], description: "Budget the client stated, as written, else null" },
            has_reference: { type: "boolean" },
            two_people: { type: "boolean" },
            not_ready: { type: "boolean" },
            courtesy_only: { type: "boolean" },
            summary: { type: "string", description: "One or two sentences on what the client wants" },
          },
          required: ["style", "named_artist", "preferred_weekdays", "budget", "has_reference", "two_people", "not_ready", "courtesy_only", "summary"],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: { type: "tool", name: "classify", disable_parallel_tool_use: true },
  });

  const raw = toolInput<Record<string, unknown>>(message, "classify");
  return { classification: validateClassification(raw, styleNames), usage: usageOf(message) };
}

function validateClassification(raw: Record<string, unknown>, styleNames: string[]): Classification {
  const style = typeof raw.style === "string" && styleNames.some((s) => s.toLowerCase() === (raw.style as string).toLowerCase())
    ? styleNames.find((s) => s.toLowerCase() === (raw.style as string).toLowerCase())!
    : "unclear";
  const days = Array.isArray(raw.preferred_weekdays) ? raw.preferred_weekdays : [];
  const preferred_weekdays = days
    .map((d) => WEEKDAY_ENUM.indexOf(String(d).toLowerCase().slice(0, 3) as (typeof WEEKDAY_ENUM)[number]))
    .filter((i): i is Weekday => i >= 0) as Weekday[];
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    style,
    named_artist: str(raw.named_artist),
    preferred_weekdays: [...new Set(preferred_weekdays)],
    budget: str(raw.budget),
    has_reference: raw.has_reference === true,
    two_people: raw.two_people === true,
    not_ready: raw.not_ready === true,
    courtesy_only: raw.courtesy_only === true,
    summary: str(raw.summary) ?? "",
  };
}

// ---------------------------------------------------------------------------
// Step 3: draft (default model), then hard rules, one retry with the failures.
// ---------------------------------------------------------------------------

export type DraftInput = {
  settings: MessagingSettings;
  thread: ThreadMessage[];
  classification: Classification;
  bucket: Bucket;
  /** Already chosen by code. Empty = no dates to offer. */
  slots: OfferedSlot[];
  /** sms when the thread has run over text, else email. */
  channelHint: "sms" | "email";
  nowIso: string;
};

export async function draftReply(workspaceId: string, input: DraftInput): Promise<DraftResult> {
  const { settings } = input;
  const usage: TokenUsage[] = [];
  const system = loadInstructions();
  const base = renderDraftRequest(input);

  let feedback: string | null = null;
  let last: { draft: DraftOutput; failures: RuleFailure[] } | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const content = feedback ? `${base}\n\nYOUR PREVIOUS DRAFT BROKE THESE HARD RULES. Fix every one and return the full draft again:\n${feedback}` : base;
    const message = await client().messages.create({
      model: MODELS.default,
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content }],
      tools: [draftTool(settings)],
      tool_choice: { type: "tool", name: "draft_reply", disable_parallel_tool_use: true },
    });
    usage.push(usageOf(message));

    const draft = validateDraft(toolInput<Record<string, unknown>>(message, "draft_reply"), input.channelHint);
    const result = checkDraft({ body: draft.body, subject: draft.subject, slots: input.slots }, settings);
    if (result.ok) return { ok: true, draft, usage, attempts: attempt };

    last = { draft, failures: result.failures };
    feedback = result.failures.map((f) => `- ${f.rule}: ${f.detail}`).join("\n");
  }

  // Still failing after the retry: never propose. Rule ids only in telemetry.
  const failures = last?.failures ?? [];
  await emitTelemetry(
    workspaceId,
    "messaging.hard_rule_blocked",
    { rules: [...new Set(failures.map((f) => f.rule))].sort().join(","), bucket: input.bucket, attempts: 2 },
    { id: MODULE_ID, version: MODULE_VERSION },
  );
  return { ok: false, failures, usage, attempts: 2 };
}

function renderDraftRequest(input: DraftInput): string {
  const { settings, classification, slots } = input;
  const tz = settings.timezone;
  const slotLines = slots.map((s) => `- ${formatSlot(s.starts_at, tz)} (with ${s.artist})`);
  const style = classification.style === "unclear" ? null : settings.styles.find((s) => s.name === classification.style);
  const bucketNote: Record<Bucket, string> = {
    unreplied: "The client's latest message has not been answered. Reply to it.",
    new: "This is a new enquiry with no reply yet.",
    quiet: "The thread went quiet after our last message. Write a short chaser that follows on, not a repeat.",
  };

  return [
    `BUSINESS: ${settings.business_name}`,
    `SIGNS OFF AS: ${settings.sender_name}`,
    `TIMEZONE: ${tz}. Current local time: ${formatSlot(input.nowIso, tz)}.`,
    `SITUATION: ${bucketNote[input.bucket]}`,
    `CHANNEL: ${input.channelHint === "sms" ? "Reply by text (the thread runs over SMS)." : "Reply by email."}`,
    "",
    "VOICE (how this business writes):",
    settings.voice || "(none given)",
    "",
    "PRICE BOOK:",
    settings.price_book || "(none given: do not quote a price)",
    "",
    "GUIDANCE (extra rules):",
    settings.guidance || "(none)",
    "",
    "ROSTER (the only people you may name):",
    renderRoster(settings),
    "",
    "WHAT CODE HAS DECIDED:",
    `- style: ${classification.style}${style?.consult_only ? " (consult only: offer a consult, no quote)" : ""}`,
    `- client named a person: ${classification.named_artist ?? "no"}`,
    `- client asked for days: ${classification.preferred_weekdays.length ? classification.preferred_weekdays.map((d) => WEEKDAY_ENUM[d]).join(", ") : "no"}`,
    `- budget stated: ${classification.budget ?? "no"}`,
    `- has reference/description: ${classification.has_reference ? "yes" : "no (ask for photos; don't quote)"}`,
    `- two people: ${classification.two_people ? "yes" : "no"}`,
    `- not ready yet: ${classification.not_ready ? "yes (no dates)" : "no"}`,
    `- courtesy only: ${classification.courtesy_only ? "yes (optional very short reply)" : "no"}`,
    "",
    "DATES TO OFFER (write them exactly like this; offer no others):",
    slotLines.length ? slotLines.join("\n") : "(none: do not offer dates)",
    "",
    "THREAD:",
    renderThread(input.thread, tz),
  ].join("\n");
}

function draftTool(settings: MessagingSettings): Anthropic.Tool {
  const artistNames = settings.artists.filter((a) => a.active && a.in_house).map((a) => a.name);
  return {
    name: "draft_reply",
    description: "Return the complete reply and the notes for the approver.",
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["sms", "email"] },
        subject: { type: ["string", "null"], description: "Email only" },
        body: { type: "string", description: "The complete reply, ready to send" },
        artist: { type: ["string", "null"], enum: [...artistNames, null], description: "Person offered, or null" },
        price: { type: ["string", "null"], description: "Price exactly as written in the body, or null" },
        price_confidence: { type: ["string", "null"], enum: ["confident", "rough", "guess", null] },
        waiting_for: { type: "string", description: "One line: what the client is waiting for" },
        rationale: { type: "string", description: "Why this person, dates and price. For the approver only." },
        flags: { type: "array", items: { type: "string" }, description: "Things the approver must check or do" },
      },
      required: ["channel", "subject", "body", "artist", "price", "price_confidence", "waiting_for", "rationale", "flags"],
      additionalProperties: false,
    },
  };
}

function validateDraft(raw: Record<string, unknown>, channelHint: "sms" | "email"): DraftOutput {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const body = str(raw.body);
  if (!body) throw new Error("Model returned an empty draft body");
  const channel = raw.channel === "sms" || raw.channel === "email" ? raw.channel : channelHint;
  const conf = raw.price_confidence;
  return {
    channel,
    subject: channel === "email" ? (str(raw.subject) ?? undefined) : undefined,
    body,
    artist: str(raw.artist),
    price: str(raw.price),
    price_confidence: conf === "confident" || conf === "rough" || conf === "guess" ? conf : null,
    waiting_for: str(raw.waiting_for) ?? "",
    rationale: str(raw.rationale) ?? "",
    flags: Array.isArray(raw.flags) ? raw.flags.filter((f): f is string => typeof f === "string" && f.trim().length > 0) : [],
  };
}

/** Sum usage for cost telemetry (counts only). */
export function sumUsage(usage: TokenUsage[]): { input_tokens: number; output_tokens: number; calls: number } {
  return usage.reduce(
    (acc, u) => ({ input_tokens: acc.input_tokens + u.input_tokens, output_tokens: acc.output_tokens + u.output_tokens, calls: acc.calls + 1 }),
    { input_tokens: 0, output_tokens: 0, calls: 0 },
  );
}
