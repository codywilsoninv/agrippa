"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/(app)/settings/actions";

type Field = { name: string; label: string; type?: "text" | "password"; placeholder?: string; hint?: string };

type Props = {
  provider: string;
  title: string;
  status: { status: string; account: string | null; updatedAt: string | null } | null;
  fields: Field[];
  canEdit: boolean;
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
};

// One provider's card. Secrets are never prefilled: the form only ever sends new ones.
export function ConnectionForm({ provider, title, status, fields, canEdit, action }: Props) {
  const [state, formAction, pending] = useActionState(action, null);

  const badge =
    status?.status === "connected"
      ? { text: "Connected", cls: "bg-ok-soft text-ok" }
      : status?.status === "error"
        ? { text: "Needs attention", cls: "bg-warn-soft text-warn" }
        : { text: "Not connected", cls: "bg-rule text-muted" };

  return (
    <section aria-labelledby={`${provider}-title`} className="flex flex-col gap-4 rounded-sm bg-surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${provider}-title`} className="m-0 font-display text-xl font-normal">
          {title}
        </h3>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${badge.cls}`}>{badge.text}</span>
      </div>
      {status?.account ? (
        <p className="m-0 text-sm text-muted">Account: {status.account}</p>
      ) : null}

      {canEdit ? (
        <form action={formAction} className="flex flex-col gap-3" autoComplete="off">
          {fields.map((f) => (
            <div key={f.name} className="flex flex-col gap-1">
              <label htmlFor={`${provider}-${f.name}`} className="label-caps">
                {f.label}
              </label>
              <input
                id={`${provider}-${f.name}`}
                name={f.name}
                type={f.type ?? "text"}
                required
                placeholder={f.placeholder}
                autoComplete={f.type === "password" ? "new-password" : "off"}
                className="input-base"
              />
              {f.hint ? <span className="text-xs text-muted">{f.hint}</span> : null}
            </div>
          ))}
          {state?.error ? (
            <p role="alert" className="m-0 rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          {state?.ok ? (
            <p role="status" className="m-0 rounded-sm bg-ok-soft px-3 py-2 text-sm text-ok">
              {state.ok}
            </p>
          ) : null}
          <div>
            <button type="submit" disabled={pending} className="btn-primary disabled:opacity-60">
              {pending ? "Testing…" : status?.status === "connected" ? "Test and replace" : "Test and connect"}
            </button>
          </div>
        </form>
      ) : (
        <p className="m-0 text-sm text-muted">Only workspace admins can change connections.</p>
      )}
    </section>
  );
}
