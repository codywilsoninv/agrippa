import type { MessageRow } from "@/app/(app)/messaging/data";
import { channelLabel, formatDateTime } from "@/components/format";

export function ThreadHistory({ messages, timezone }: { messages: MessageRow[]; timezone: string }) {
  if (messages.length === 0) {
    return <p className="text-sm text-muted">No earlier messages on this thread.</p>;
  }
  return (
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm text-accent">
        <span className="inline-block w-3 transition-transform group-open:rotate-90" aria-hidden="true">
          ▸
        </span>
        Thread history ({messages.length} {messages.length === 1 ? "message" : "messages"})
      </summary>
      <ol className="mt-3 flex flex-col gap-3">
        {messages.map((m) => (
          <li
            key={m.id}
            className={`flex max-w-[64ch] flex-col gap-1 rounded-sm px-4 py-3 ${
              m.channel === "note" ? "border border-dashed border-rule-strong bg-panel" : m.direction === "outbound" ? "ml-6 bg-accent-soft" : "bg-surface"
            }`}
          >
            <span className="flex flex-wrap justify-between gap-2 text-xs text-muted">
              <span>
                {m.channel === "note"
                  ? `Note / transcript${m.author ? ` · ${m.author}` : ""}`
                  : `${m.direction === "outbound" ? "Us" : m.author || "Client"} · ${channelLabel(m.channel)}`}
              </span>
              <span>{formatDateTime(m.sent_at, timezone)}</span>
            </span>
            <p className="m-0 whitespace-pre-line leading-relaxed">{m.body}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}
