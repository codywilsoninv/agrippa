import "server-only";
import { getConnection } from "@/lib/connections";
import { AcuityClient, type AcuityAppointmentType, type AcuityCalendar } from "@/modules/messaging/acuity";

// Shows the Acuity calendar and appointment-type numbers that each artist's
// settings need (acuity_calendar_id, acuity_appointment_type_id). Admins only:
// the caller has already verified the session and admin role for this workspace.
export async function AcuityReference({ workspaceId }: { workspaceId: string }) {
  const conn = await getConnection(workspaceId, "acuity");
  if (!conn) return null;

  let calendars: AcuityCalendar[] = [];
  let types: AcuityAppointmentType[] = [];
  let error: string | null = null;
  try {
    const client = new AcuityClient(conn.secrets);
    [calendars, types] = await Promise.all([client.listCalendars(), client.listAppointmentTypes()]);
  } catch (e) {
    error = e instanceof Error ? e.message : "Couldn't read Acuity.";
  }

  return (
    <details className="rounded-sm bg-surface px-6 py-4">
      <summary className="cursor-pointer font-semibold">Acuity numbers for artist settings</summary>
      {error ? (
        <p className="m-0 mt-3 text-sm text-danger">{error}</p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="min-w-0">
            <span className="label-caps">Calendars → acuity_calendar_id</span>
            <ul className="m-0 mt-2 list-none p-0 text-sm">
              {calendars.map((c) => (
                <li key={c.id} className="flex justify-between gap-4 border-b border-rule py-1.5">
                  <span>{c.name}</span>
                  <code className="tabular-nums">{c.id}</code>
                </li>
              ))}
            </ul>
          </div>
          <div className="min-w-0">
            <span className="label-caps">Appointment types → acuity_appointment_type_id</span>
            <ul className="m-0 mt-2 list-none p-0 text-sm">
              {types
                .filter((t) => t.active)
                .map((t) => (
                  <li key={t.id} className="flex justify-between gap-4 border-b border-rule py-1.5">
                    <span>
                      {t.name} <span className="text-muted">· {t.duration} min</span>
                    </span>
                    <code className="tabular-nums">{t.id}</code>
                  </li>
                ))}
            </ul>
          </div>
        </div>
      )}
    </details>
  );
}
