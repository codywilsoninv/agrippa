"use client";

import { useActionState } from "react";
import type { RenameState } from "@/app/(app)/workspace-actions";

export function WorkspaceRename({
  name,
  action,
}: {
  name: string;
  action: (prev: RenameState, formData: FormData) => Promise<RenameState>;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <label htmlFor="workspace-name" className="label-caps">
        Workspace name
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="workspace-name"
          name="name"
          defaultValue={name}
          required
          minLength={1}
          maxLength={120}
          className="input-base max-w-sm"
        />
        <button type="submit" disabled={pending} className="btn-secondary disabled:opacity-60">
          {pending ? "Saving…" : "Rename"}
        </button>
      </div>
      {state?.error ? (
        <p role="alert" className="m-0 text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state?.ok ? (
        <p role="status" className="m-0 text-sm text-ok">
          Renamed.
        </p>
      ) : null}
    </form>
  );
}
