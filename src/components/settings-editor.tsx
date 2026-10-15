"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/(app)/settings/actions";

type Props = {
  initialJson: string;
  canEdit: boolean;
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
};

// v0.1: the whole MessagingSettings object as JSON. Validation happens server-side.
export function SettingsEditor({ initialJson, canEdit, action }: Props) {
  const [state, formAction, pending] = useActionState(action, null);
  const rows = Math.min(60, Math.max(16, initialJson.split("\n").length + 2));

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label htmlFor="settings-json" className="label-caps">
        Module settings (JSON)
      </label>
      <textarea
        id="settings-json"
        name="settings"
        defaultValue={initialJson}
        readOnly={!canEdit}
        rows={rows}
        spellCheck={false}
        className="input-base font-mono text-[13px] leading-relaxed"
      />
      {state?.error ? (
        <div role="alert" className="flex flex-col gap-1 rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">
          <span>{state.error}</span>
          {state.problems && state.problems.length > 0 ? (
            <ul className="m-0 list-disc pl-5">
              {state.problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {state?.ok ? (
        <p role="status" className="m-0 rounded-sm bg-ok-soft px-3 py-2 text-sm text-ok">
          {state.ok}
        </p>
      ) : null}
      {canEdit ? (
        <div>
          <button type="submit" disabled={pending} className="btn-primary disabled:opacity-60">
            {pending ? "Checking…" : "Save settings"}
          </button>
        </div>
      ) : (
        <p className="m-0 text-sm text-muted">Only workspace admins can change settings.</p>
      )}
    </form>
  );
}
