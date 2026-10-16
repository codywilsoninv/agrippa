"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/(app)/settings/actions";
import type { Need, Provider, ProviderGuide } from "@/lib/providers";

type Props = {
  provider: Provider;
  guide: ProviderGuide;
  need: Need;
  why: string;
  status: { status: string; account: string | null; updatedAt: string | null } | null;
  canEdit: boolean;
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
};

const NEED_LABEL: Record<Need, string> = {
  required: "Required",
  optional: "Optional",
  later: "Not needed yet",
};

// One provider's card: why the module needs it, where to find each value
// (open until it's connected), and the form. Secrets are never prefilled.
export function ConnectionForm({ provider, guide, need, why, status, canEdit, action }: Props) {
  const [state, formAction, pending] = useActionState(action, null);
  const connected = status?.status === "connected";

  const badge = connected
    ? { text: "Connected", cls: "bg-ok-soft text-ok" }
    : status?.status === "error"
      ? { text: "Needs attention", cls: "bg-warn-soft text-warn" }
      : !guide.available
        ? { text: "Coming later", cls: "bg-rule text-muted" }
        : { text: "Not connected", cls: need === "required" ? "bg-danger-soft text-danger" : "bg-rule text-muted" };

  return (
    <section
      aria-labelledby={`${provider}-title`}
      className={`flex flex-col gap-4 rounded-sm bg-surface p-6 ${need === "required" && !connected ? "border-t-[3px] border-accent" : ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="label-caps">{NEED_LABEL[need]}</span>
          <h3 id={`${provider}-title`} className="m-0 font-display text-xl font-normal">
            {guide.name}
          </h3>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${badge.cls}`}>{badge.text}</span>
      </div>
      <p className="m-0 text-sm text-ink-soft">{why}</p>
      {status?.account ? <p className="m-0 text-sm text-muted">Account: {status.account}</p> : null}

      <details open={!connected && guide.available} className="rounded-sm bg-panel px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold">How to find these</summary>
        <ol className="m-0 mt-3 flex flex-col gap-2 pl-5 text-sm leading-relaxed">
          {guide.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        {guide.caution ? <p className="m-0 mt-3 text-sm text-muted">{guide.caution}</p> : null}
      </details>

      {!guide.available ? null : canEdit ? (
        <form action={formAction} className="flex flex-col gap-3" autoComplete="off">
          <input type="hidden" name="provider" value={provider} />
          {guide.fields.map((f) => (
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
            <button type="submit" disabled={pending} className={connected ? "btn-secondary disabled:opacity-60" : "btn-primary disabled:opacity-60"}>
              {pending ? "Testing…" : connected ? "Test and replace" : "Test and connect"}
            </button>
          </div>
        </form>
      ) : (
        <p className="m-0 text-sm text-muted">Only workspace admins can change connections.</p>
      )}
    </section>
  );
}
