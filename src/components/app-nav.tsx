"use client";

import { useState } from "react";
import type { Workspace } from "@/lib/workspace";
import { Wordmark } from "@/components/wordmark";
import { NavLink } from "@/components/nav-link";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";

type Props = {
  workspace: Workspace;
  all: Workspace[];
  openDrafts: number;
  footer: string;
  switchAction: (formData: FormData) => void | Promise<void>;
  createAction: (formData: FormData) => void | Promise<void>;
};

// Dark left nav on wide screens; a top bar with a disclosure menu on phones.
export function AppNav({ workspace, all, openDrafts, footer, switchAction, createAction }: Props) {
  const [open, setOpen] = useState(false);

  const body = (
    <>
      <div className="flex flex-col gap-1">
        <NavLink href="/messaging" label="Messaging" badge={openDrafts} />
        <NavLink href="/settings" label="Settings" />
      </div>
      <WorkspaceSwitcher current={workspace} all={all} switchAction={switchAction} createAction={createAction} />
      <div className="mt-auto flex flex-col gap-3 text-xs leading-relaxed text-nav-muted">
        <span>{footer}</span>
        <form action="/auth/signout" method="post">
          <button type="submit" className="min-h-11 rounded-md border border-nav-active px-3 text-sm text-nav-text hover:bg-nav-active">
            Sign out
          </button>
        </form>
      </div>
    </>
  );

  return (
    <nav aria-label="Modules" className="bg-nav text-nav-text md:flex md:w-[230px] md:shrink-0 md:flex-col md:gap-7 md:px-5 md:py-7">
      <div className="flex items-center justify-between px-4 py-3 md:block md:p-0">
        <div className="flex flex-col gap-1">
          <Wordmark />
          <span className="text-xs text-nav-muted">{workspace.name}</span>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="app-nav-menu"
          onClick={() => setOpen((v) => !v)}
          className="min-h-11 min-w-11 rounded-md border border-nav-active px-3 text-sm md:hidden"
        >
          {open ? "Close" : "Menu"}
        </button>
      </div>
      <div
        id="app-nav-menu"
        className={`${open ? "flex" : "hidden"} flex-col gap-6 px-4 pb-5 md:flex md:flex-1 md:gap-7 md:p-0`}
      >
        {body}
      </div>
    </nav>
  );
}
