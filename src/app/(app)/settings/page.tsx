import { isAdmin, requireWorkspace } from "@/lib/workspace";
import { listConnections } from "@/lib/connections";
import { createClient } from "@/lib/supabase/server";
import { ConnectionForm } from "@/components/connection-form";
import { SettingsEditor } from "@/components/settings-editor";
import { SettingsSummary } from "@/components/settings-summary";
import { AcuityReference } from "@/components/acuity-reference";
import { WorkspaceRename } from "@/components/workspace-rename";
import { formatDateTime } from "@/components/format";
import { loadModuleState } from "../messaging/data";
import { renameWorkspace } from "../workspace-actions";
import { saveAcuity, savePipedrive, saveSettings, setModuleEnabled } from "./actions";

export const metadata = { title: "Settings · Agrippa" };

type Search = Promise<{ saved?: string | string[]; error?: string | string[] }>;

type MemberRow = { user_id: string; role: string; created_at: string };
type PersonRow = { user_id: string | null; name: string; email: string | null };

export default async function SettingsPage({ searchParams }: { searchParams: Search }) {
  const { userId, workspace } = await requireWorkspace();
  const admin = isAdmin(workspace);
  const params = await searchParams;
  const saved = Array.isArray(params.saved) ? params.saved[0] : params.saved;
  const error = Array.isArray(params.error) ? params.error[0] : params.error;

  const supabase = await createClient();
  const [connections, module, { data: members }, { data: people }] = await Promise.all([
    listConnections(workspace.id),
    loadModuleState(workspace.id),
    supabase.from("memberships").select("user_id, role, created_at").eq("workspace_id", workspace.id).returns<MemberRow[]>(),
    supabase.from("people").select("user_id, name, email").eq("workspace_id", workspace.id).not("user_id", "is", null).returns<PersonRow[]>(),
  ]);

  const byProvider = (p: string) => {
    const c = connections.find((x) => x.provider === p);
    return c ? { status: c.status, account: c.external_account, updatedAt: c.updated_at } : null;
  };
  const personFor = new Map((people ?? []).map((p) => [p.user_id, p]));
  const settingsJson = JSON.stringify(module.settings, null, 2);

  return (
    <main className="flex flex-1 flex-col gap-10 px-4 py-7 sm:px-10">
      <header className="flex flex-col gap-1">
        <span className="label-caps">{workspace.name}</span>
        <h1 className="m-0 font-display text-[30px] font-normal leading-tight">Settings</h1>
        {saved === "workspace" ? (
          <p role="status" className="m-0 mt-2 max-w-md rounded-sm bg-ok-soft px-3 py-2 text-sm text-ok">
            Workspace created. You are now working in it.
          </p>
        ) : null}
        {error === "workspace_name" ? <Problem>Give the new workspace a name of 1 to 120 characters.</Problem> : null}
        {error === "workspace_create" ? <Problem>Couldn&apos;t create the workspace. Try again.</Problem> : null}
      </header>

      <section id="connections" aria-labelledby="connections-title" className="flex flex-col gap-4">
        <SectionTitle id="connections-title" title="Connections" blurb="Where Messaging reads enquiries and staff availability from. Keys are tested before they are stored, and never shown again." />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ConnectionForm
            provider="pipedrive"
            title="Pipedrive"
            status={byProvider("pipedrive")}
            canEdit={admin}
            action={savePipedrive}
            fields={[
              { name: "company_domain", label: "Company domain", placeholder: "umbratattoo", hint: "The first part of your Pipedrive address: <domain>.pipedrive.com" },
              { name: "api_token", label: "API token", type: "password", hint: "Pipedrive: Settings, Personal preferences, API." },
            ]}
          />
          <ConnectionForm
            provider="acuity"
            title="Acuity Scheduling"
            status={byProvider("acuity")}
            canEdit={admin}
            action={saveAcuity}
            fields={[
              { name: "user_id", label: "User id", hint: "Acuity: Settings, Integrations, API." },
              { name: "api_key", label: "API key", type: "password" },
            ]}
          />
        </div>
      </section>

      <section id="module" aria-labelledby="module-title" className="flex flex-col gap-4">
        <SectionTitle id="module-title" title="Messaging module" blurb="Switch the module on, then describe the business: who the artists are, which styles go to whom, and how Pipedrive stages map." />
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm bg-surface px-6 py-4">
          <span>
            Messaging is <strong className="font-semibold">{module.enabled ? "on" : "off"}</strong>
          </span>
          {admin ? (
            <form action={setModuleEnabled}>
              <input type="hidden" name="enabled" value={module.enabled ? "false" : "true"} />
              <button type="submit" className={module.enabled ? "btn-secondary" : "btn-primary"}>
                {module.enabled ? "Switch off" : "Switch on"}
              </button>
            </form>
          ) : null}
        </div>
        <SettingsSummary settings={module.settings} />
        {admin ? <AcuityReference workspaceId={workspace.id} /> : null}
        <SettingsEditor initialJson={settingsJson} canEdit={admin} action={saveSettings} />
      </section>

      <section id="workspace" aria-labelledby="workspace-title" className="flex flex-col gap-4">
        <SectionTitle id="workspace-title" title="Workspace" blurb="The business this screen belongs to, and who can see it." />
        <div className="flex flex-col gap-6 rounded-sm bg-surface p-6">
          {admin ? <WorkspaceRename name={workspace.name} action={renameWorkspace} /> : <p className="m-0">{workspace.name}</p>}
          <div className="flex flex-col gap-2">
            <span className="label-caps">Members ({members?.length ?? 0})</span>
            <ul className="m-0 flex list-none flex-col divide-y divide-rule p-0">
              {(members ?? []).map((m) => {
                const person = personFor.get(m.user_id);
                return (
                  <li key={m.user_id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <span>
                      {person?.name ?? "Member"}
                      {m.user_id === userId ? <span className="text-muted"> (you)</span> : null}
                      {person?.email ? <span className="text-muted"> · {person.email}</span> : null}
                    </span>
                    <span className="text-xs text-muted">
                      {m.role} · since {formatDateTime(m.created_at, module.settings.timezone)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </section>
    </main>
  );
}

function SectionTitle({ id, title, blurb }: { id: string; title: string; blurb: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 id={id} className="m-0 font-display text-2xl font-normal">
        {title}
      </h2>
      <p className="m-0 max-w-[62ch] text-muted">{blurb}</p>
    </div>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="m-0 mt-2 max-w-md rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}
