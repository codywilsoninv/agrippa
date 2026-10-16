"use client";

import { useState } from "react";
import type { Workspace } from "@/lib/workspace";

type Props = {
  current: Workspace;
  all: Workspace[];
  switchAction: (formData: FormData) => void | Promise<void>;
  createAction: (formData: FormData) => void | Promise<void>;
};

// Lives in the dark nav. A select submits on change; "New workspace" reveals a
// one-field form that calls the create_workspace SQL function.
export function WorkspaceSwitcher({ current, all, switchAction, createAction }: Props) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      {all.length > 1 ? (
        <form action={switchAction}>
          <label htmlFor="workspace-select" className="sr-only">
            Workspace
          </label>
          <select
            id="workspace-select"
            name="workspace_id"
            defaultValue={current.id}
            onChange={(e) => e.currentTarget.form?.requestSubmit()}
            className="min-h-11 w-full rounded-md border border-nav-active bg-nav-active px-2 text-sm text-nav-text"
          >
            {all.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <noscript>
            <button type="submit" className="mt-2 min-h-11 w-full rounded-md border border-nav-active text-sm text-nav-text">
              Switch
            </button>
          </noscript>
        </form>
      ) : (
        <span className="text-xs text-nav-muted">{current.name}</span>
      )}

      {creating ? (
        <form action={createAction} className="flex flex-col gap-2">
          <label htmlFor="new-workspace-name" className="label-caps text-nav-muted">
            New workspace
          </label>
          <input
            id="new-workspace-name"
            name="name"
            required
            minLength={1}
            maxLength={120}
            autoFocus
            placeholder="Business name"
            className="min-h-11 w-full rounded-md border border-nav-active bg-nav-active px-3 text-sm text-nav-text placeholder:text-nav-muted"
          />
          <div className="flex gap-2">
            <button type="submit" className="min-h-11 flex-1 rounded-md bg-nav-badge px-3 text-sm font-semibold text-ink">
              Create
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="min-h-11 rounded-md px-3 text-sm text-nav-muted hover:text-white"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="min-h-11 self-start rounded-md px-1 text-left text-xs text-nav-muted hover:text-white"
        >
          + New workspace
        </button>
      )}
    </div>
  );
}
