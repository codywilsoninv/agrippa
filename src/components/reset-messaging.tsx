"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/app/(app)/settings/actions";

// Admin-only. Two steps on the page itself (no browser confirm()): open the
// panel, type RESET, then press the button.
export function ResetMessaging({ action }: { action: (prev: FormState, formData: FormData) => Promise<FormState> }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <div className="flex flex-col gap-3 rounded-sm border border-rule bg-surface px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-semibold">Reset Messaging data</span>
          <span className="text-sm text-muted">
            Removes everything Messaging collected and drafted for this workspace. Your Pipedrive, ClickSend and Acuity data are untouched.
          </span>
        </div>
        {!open ? (
          <button type="button" onClick={() => setOpen(true)} className="btn-secondary">
            Reset…
          </button>
        ) : null}
      </div>
      {open ? (
        <form action={formAction} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>Type RESET to confirm</span>
            <input name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} className="input-base w-40" autoComplete="off" />
          </label>
          <button type="submit" disabled={pending || typed !== "RESET"} className="btn-primary disabled:opacity-60">
            {pending ? "Resetting…" : "Reset Messaging data"}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="btn-quiet">
            Cancel
          </button>
        </form>
      ) : null}
      {state?.error ? (
        <p role="alert" className="m-0 text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state?.ok ? (
        <p role="status" className="m-0 text-sm text-ok">
          {state.ok}
        </p>
      ) : null}
    </div>
  );
}
