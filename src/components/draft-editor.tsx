"use client";

import { useActionState, useState } from "react";
import type { DecisionState } from "@/app/(app)/messaging/actions";

type Props = {
  actionId: string;
  channel: "sms" | "email";
  initialSubject: string;
  initialBody: string;
  previousError: string | null;
  /** False when there is no Pipedrive deal to save the note to. */
  hasDeal: boolean;
  approveAction: (prev: DecisionState, formData: FormData) => Promise<DecisionState>;
  denyAction: (formData: FormData) => void | Promise<void>;
};

// The draft card: editable text, the assistant label, and the three decisions.
export function DraftEditor({
  actionId,
  channel,
  initialSubject,
  initialBody,
  previousError,
  hasDeal,
  approveAction,
  denyAction,
}: Props) {
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [state, formAction, pending] = useActionState(approveAction, null);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  const fullText = channel === "email" && subject ? `Subject: ${subject}\n\n${body}` : body;

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(fullText);
      } else {
        const ta = document.createElement("textarea");
        ta.value = fullText;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("copy failed");
      }
      setCopied("done");
    } catch {
      setCopied("failed");
    }
    setTimeout(() => setCopied("idle"), 2500);
  }

  const error = state?.error ?? previousError;

  // With no Pipedrive deal there is nothing to save to, so approving means
  // "I'll send this myself": put the final text on the clipboard as part of
  // the same click, then submit.
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    if (hasDeal) return;
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.dataset.role !== "approve") return; // Deny has its own formAction
    await copy();
  }

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-4">
        <input type="hidden" name="action_id" value={actionId} />
        {channel === "email" ? (
          <div className="flex flex-col gap-1">
            <label htmlFor="draft-subject" className="label-caps">
              Subject
            </label>
            <input
              id="draft-subject"
              name="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="input-base"
            />
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <label htmlFor="draft-body" className="label-caps">
            {channel === "email" ? "Email" : "Text message"}
          </label>
          <textarea
            id="draft-body"
            name="body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={Math.min(24, Math.max(8, body.split("\n").length + 2))}
            className="input-base max-w-[64ch] leading-[1.7]"
          />
        </div>

        {error ? (
          <p role="alert" className="rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2.5">
          <button type="submit" data-role="approve" disabled={pending} className="btn-primary disabled:opacity-60">
            {pending ? "Saving…" : hasDeal ? "Approve and save to Pipedrive" : "Copy and mark as sent"}
          </button>
          <button type="button" onClick={copy} className="btn-secondary">
            {copied === "done" ? "Copied" : copied === "failed" ? "Couldn't copy" : "Copy"}
          </button>
          <button type="submit" formAction={denyAction} formNoValidate disabled={pending} className="btn-quiet disabled:opacity-60">
            Deny
          </button>
        </div>
      </form>
    </div>
  );
}
