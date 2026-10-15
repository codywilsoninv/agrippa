import type { MessagingSettings } from "@/modules/messaging/types";

// Readable cards so the setup can be checked without reading the JSON.
export function SettingsSummary({ settings }: { settings: MessagingSettings }) {
  const stylesByArtist = new Map<string, string[]>();
  for (const style of settings.styles) {
    const ranked = Object.entries(style.ranks).sort((a, b) => a[1] - b[1]);
    for (const [artist] of ranked) {
      stylesByArtist.set(artist, [...(stylesByArtist.get(artist) ?? []), style.name]);
    }
  }
  const stageWord: Record<string, string> = {
    new: "new enquiry",
    follow_up: "follow up",
    booked: "booked",
    ignore: "ignored",
  };

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <Card title={`Artists (${settings.artists.length})`}>
        {settings.artists.length === 0 ? (
          <Muted>None set.</Muted>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {settings.artists.map((a) => {
              const styles = stylesByArtist.get(a.name) ?? [];
              return (
                <li key={a.name} className="flex flex-col">
                  <span className="font-semibold">
                    {a.name}
                    {!a.active ? <Muted> · inactive</Muted> : null}
                    {!a.in_house ? <Muted> · own books</Muted> : null}
                  </span>
                  <Muted>
                    {styles.length > 0 ? styles.join(", ") : "No styles ranked"}
                    {a.acuity_calendar_id ? ` · Acuity ${a.acuity_calendar_id}` : " · dates from staff"}
                    {` · from ${a.day_start}`}
                  </Muted>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title={`Styles (${settings.styles.length})`}>
        {settings.styles.length === 0 ? (
          <Muted>None set.</Muted>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {settings.styles.map((s) => {
              const ranked = Object.entries(s.ranks)
                .sort((a, b) => a[1] - b[1])
                .map(([name, rank]) => `${rank}. ${name}`);
              return (
                <li key={s.name} className="flex flex-col">
                  <span className="font-semibold">
                    {s.name}
                    {s.consult_only ? <Muted> · consult first</Muted> : null}
                  </span>
                  <Muted>{ranked.length > 0 ? ranked.join(" · ") : "Nobody ranked"}</Muted>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title={`CRM stages (${settings.crm.stages.length})`}>
        <Muted>Label used when Agrippa sends messages itself: {settings.assistant_label || "not set"}</Muted>
        <Muted>
          Pipeline {settings.crm.pipeline_id} · quiet after {settings.crm.quiet_after_hours}h · offer {settings.slots.offer_count} dates within{" "}
          {settings.slots.lookahead_days} days
        </Muted>
        {settings.crm.stages.length === 0 ? (
          <Muted>No stages mapped.</Muted>
        ) : (
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
            {settings.crm.stages.map((st) => (
              <li key={st.id} className="flex justify-between gap-3">
                <span>{st.name}</span>
                <Muted>{stageWord[st.treat_as] ?? st.treat_as}</Muted>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-sm bg-surface p-5">
      <h3 className="label-caps m-0 font-normal">{title}</h3>
      {children}
    </section>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-muted">{children}</span>;
}
