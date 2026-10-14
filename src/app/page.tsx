import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Agrippa" };

type Membership = {
  role: string;
  workspaces: { id: string; name: string } | null;
};

export default async function Home() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) redirect("/login");

  const { data: memberships } = await supabase
    .from("memberships")
    .select("role, workspaces(id, name)")
    .returns<Membership[]>();

  const ws = memberships?.[0]?.workspaces ?? null;

  const { data: modules } = ws
    ? await supabase
        .from("workspace_modules")
        .select("module_id, enabled")
        .eq("workspace_id", ws.id)
    : { data: [] };

  return (
    <div className="min-h-screen bg-[#F5F4F0] text-[#1A1B1E]">
      <header className="sticky top-0 bg-[#1A1B1E] text-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <span className="font-bold text-lg">Agrippa</span>
          <form action="/auth/signout" method="post">
            <button className="min-h-10 px-4 rounded-lg border border-[#44474E] text-sm">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-6 py-10 flex flex-col gap-6">
        <section className="bg-white border border-[#E3E1DA] rounded-2xl p-6">
          <h1 className="text-2xl font-semibold mb-1">{ws?.name ?? "No workspace yet"}</h1>
          <p className="text-sm text-[#5C5F66]">
            Signed in as {String(claims.claims.email ?? "")} · role:{" "}
            {memberships?.[0]?.role ?? "none"}
          </p>
        </section>
        <section className="bg-white border border-[#E3E1DA] rounded-2xl p-6">
          <h2 className="text-lg font-semibold mb-2">Modules</h2>
          {modules && modules.length > 0 ? (
            <ul className="list-disc pl-5">
              {modules.map((m) => (
                <li key={m.module_id}>
                  {m.module_id} {m.enabled ? "(on)" : "(off)"}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[#5C5F66]">
              No modules switched on yet. The platform core is running; modules come next.
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
