// Messaging module: Acuity Scheduling API v1 client (read only).
// Auth is HTTP Basic with the Acuity user id and API key. Credentials are
// never logged and never included in error messages.
//
// Availability is read per appointment type and calendar: first which dates in
// a month have any opening, then the exact free start times on a date. The
// "don't squeeze" rule (routing.ts) then keeps only days where the artist's
// usual start time is free.

import type { ProviderSecrets } from "@/lib/connections";

type Secrets = ProviderSecrets["acuity"];

const BASE = "https://acuityscheduling.com/api/v1";

export type AcuityCalendar = { id: number; name: string; email?: string; timezone?: string };
export type AcuityAppointmentType = {
  id: number;
  name: string;
  duration: number; // minutes
  calendarIDs: number[];
  active: boolean;
  private?: boolean;
  type?: string; // "service" | "class" | "series"
};

export class AcuityClient {
  private readonly auth: string;

  constructor(secrets: Secrets) {
    if (!secrets.user_id || !secrets.api_key) throw new Error("Acuity user id or API key is missing");
    this.auth = "Basic " + Buffer.from(`${secrets.user_id}:${secrets.api_key}`).toString("base64");
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await fetch(url, { headers: { authorization: this.auth, accept: "application/json" }, cache: "no-store" });
    } catch (e) {
      throw new Error(`Couldn't reach Acuity (${path}): ${e instanceof Error ? e.message : "network error"}`);
    }
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      if (res.status === 401) throw new Error("Acuity rejected the user id / API key");
      const msg = isErrorBody(json) ? json.message : `HTTP ${res.status}`;
      throw new Error(`Acuity GET ${path} failed: ${msg}`);
    }
    return json as T;
  }

  /** Account check for the connections screen: returns the account's display name or email. */
  async me(): Promise<string> {
    const me = await this.get<{ email?: string; name?: string; timezone?: string }>("/me");
    return me.name || me.email || "Acuity";
  }

  listCalendars(): Promise<AcuityCalendar[]> {
    return this.get<AcuityCalendar[]>("/calendars");
  }

  listAppointmentTypes(): Promise<AcuityAppointmentType[]> {
    return this.get<AcuityAppointmentType[]>("/appointment-types");
  }

  /** Dates ("YYYY-MM-DD") in the month that have at least one opening. */
  async availableDates(appointmentTypeID: number, calendarID: number, month: string, timezone: string): Promise<string[]> {
    const rows = await this.get<{ date: string }[]>("/availability/dates", { appointmentTypeID, calendarID, month, timezone });
    return rows.map((r) => r.date);
  }

  /** Free start times on the date, as ISO strings with offset in the requested timezone. */
  async availableTimes(appointmentTypeID: number, calendarID: number, date: string, timezone: string): Promise<string[]> {
    const rows = await this.get<{ time: string; slotsAvailable?: number }[]>("/availability/times", {
      appointmentTypeID,
      calendarID,
      date,
      timezone,
    });
    return rows.filter((r) => r.slotsAvailable === undefined || r.slotsAvailable > 0).map((r) => r.time);
  }
}

function isErrorBody(x: unknown): x is { message: string } {
  return typeof x === "object" && x !== null && typeof (x as { message?: unknown }).message === "string";
}

export async function testAcuity(secrets: Secrets): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
  try {
    const account = await new AcuityClient(secrets).me();
    return { ok: true, account };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't connect to Acuity" };
  }
}
