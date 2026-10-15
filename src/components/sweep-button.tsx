"use client";

import { useActionState } from "react";
import type { SweepState } from "@/app/(app)/messaging/actions";

export function SweepButton({ action }: { action: (prev: SweepState) => Promise<SweepState> }) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <div className="flex flex-col gap-2">
      <form action={formAction}>
        <button type="submit" disabled={pending} className="btn-secondary disabled:opacity-60">
          {pending ? "Sweeping…" : "Run sweep now"}
        </button>
      </form>
      {state && "error" in state ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state && "proposed" in state ? (
        <div role="status" className="flex flex-col gap-1 text-sm text-muted">
          <span>
            Sweep finished in {(state.durationMs / 1000).toFixed(1)}s: {state.proposed} proposed, {state.skipped} skipped,{" "}
            {state.blocked} blocked by a hard rule.
          </span>
          {state.errors.length > 0 ? (
            <ul className="list-disc pl-5 text-danger">
              {state.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
