import Link from "next/link";
import { PROVIDERS } from "@/lib/providers";
import { MESSAGING_CONNECTIONS } from "@/modules/messaging/connections";
import { requireWorkspace } from "@/lib/workspace";
import { listConnections } from "@/lib/connections";
import { DraftList } from "@/components/draft-list";
import { DraftDetail } from "@/components/draft-detail";
import { SweepButton } from "@/components/sweep-button";
import { longAge, formatDateTime, localeFor } from "@/components/format";
import { lastSweep } from "../sweep-info";
import { conversationIdsOf, listOpenDrafts, listThread, loadDecidedDraft, loadModuleState } from "./data";
import { approveDraft, denyDraft, sweepNow } from "./actions";

export const metadata = { title: "Messaging · Agrippa" };
// Refresh runs as a server action on this page and can take minutes.
export const maxDuration = 300;

type Search = Promise<{ d?: string | string[]; done?: string | string[]; a?: string | string[] }>;

export default async function MessagingPage({ searchParams }: { searchParams: Search }) {
  const { workspace } = await requireWorkspace();
  const params = await searchParams;
  const wanted = Array.isArray(params.d) ? params.d[0] : params.d;
  const done = Array.isArray(params.done) ? params.done[0] : params.done;
  const doneId = Array.isArray(params.a) ? params.a[0] : params.a;

  const [module, connections, drafts, sweep] = await Promise.all([
    loadModuleState(workspace.id),
    listConnections(workspace.id),
    listOpenDrafts(workspace.id),
    lastSweep(workspace.id),
  ]);

  const connected = connections.filter((c) => c.status === "connected").map((c) => c.provider);
  const missing = MESSAGING_CONNECTIONS.filter(
    (c) => c.need === "required" && !connected.includes(c.provider as (typeof connected)[number]),
  );

  if (!module.enabled) {
    return (
      <Empty title="Messaging is switched off">
        <p className="m-0">
          Turn it on in <Link href="/settings#module">Settings</Link> to start sweeping for enquiries.
        </p>
      </Empty>
    );
  }
  if (missing.length > 0) {
    return (
      <Empty title="Finish connecting Messaging">
        <p className="m-0">
          Messaging still needs {missing.map((c) => PROVIDERS[c.provider].name).join(" and ")}. Each one has step-by-step
          instructions under <Link href="/settings#connections">Settings, Connections</Link>.
        </p>
      </Empty>
    );
  }

  const selected = drafts.find((d) => d.id === wanted) ?? drafts[0] ?? null;
  const thread = selected ? await listThread(workspace.id, conversationIdsOf(selected.payload)) : [];
  const copied = done === "copied" && doneId ? await loadDecidedDraft(workspace.id, doneId) : null;
  const oldest = drafts[0]?.waiting_since;
  const people = new Set(drafts.map((d) => d.payload.person_id ?? d.payload.job_id)).size;

  return (
    <div className="flex min-h-full flex-1 flex-col lg:flex-row">
      <section
        aria-label="Who is waiting"
        className="flex w-full flex-col gap-5 border-b border-rule bg-panel py-7 lg:w-[400px] lg:shrink-0 lg:border-b-0 lg:border-r"
      >
        <div className="flex flex-col gap-1 px-6">
          <h1 className="m-0 font-display text-[30px] font-normal leading-tight">Waiting on us</h1>
          <span className="text-muted">
            {drafts.length === 0
              ? "Nobody right now"
              : `${people} ${people === 1 ? "person" : "people"} · oldest ${longAge(oldest)}`}
          </span>
        </div>
        {done === "approved" ? <Notice>Saved to Pipedrive.</Notice> : null}
        {done === "copied" ? (
          <Notice>
            <span>Marked as sent. The text is on your clipboard; if it isn&apos;t, copy it from here and send it from ClickSend.</span>
            {copied ? (
              <pre className="m-0 mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-sm bg-panel px-3 py-2 font-sans text-sm text-ink">
                {copied.channel === "email" && copied.subject ? `Subject: ${copied.subject}\n\n` : ""}
                {copied.body}
              </pre>
            ) : null}
          </Notice>
        ) : null}
        {done === "denied" ? <Notice>Draft denied.</Notice> : null}
        {drafts.length > 0 ? (
          <DraftList drafts={drafts} selectedId={selected?.id ?? null} />
        ) : (
          <div className="flex flex-col gap-3 px-6 text-muted">
            <p className="m-0">Nobody is waiting on a reply.</p>
            <p className="m-0 text-xs">
              {sweep ? `Last refreshed ${formatDateTime(sweep.at, module.settings.timezone)} (${longAge(sweep.at)} ago).` : "Press Refresh to check every connection for new messages."}
            </p>
          </div>
        )}
        <div className="mt-auto px-6 pt-4">
          <SweepButton action={sweepNow} lastRefreshed={sweep?.at ?? null} timezone={module.settings.timezone} locale={localeFor(module.settings.country)} />
        </div>
      </section>

      <main className="flex min-w-0 flex-1 flex-col gap-6 px-4 py-7 sm:px-10">
        {selected ? (
          <DraftDetail
            draft={selected}
            thread={thread}
            timezone={module.settings.timezone}
            approveAction={approveDraft}
            denyAction={denyDraft}
          />
        ) : (
          <p className="m-0 max-w-[48ch] text-muted">
            Press Refresh. When someone is waiting on a reply, their draft appears here for you to check and approve.
          </p>
        )}
      </main>
    </div>
  );
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex flex-1 flex-col gap-3 px-4 py-10 sm:px-10">
      <h1 className="m-0 font-display text-[30px] font-normal leading-tight">{title}</h1>
      <div className="max-w-[52ch] text-muted">{children}</div>
    </main>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" className="mx-6 my-0 rounded-sm bg-ok-soft px-3 py-2 text-sm text-ok">
      {children}
    </div>
  );
}
