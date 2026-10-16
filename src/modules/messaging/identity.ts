// Messaging module: one client = one Person. PURE, no imports.
//
// Every source (CRM record, a text, an email) gives us a contact with some of:
// a CRM person id, a phone in E.164, an email address. This decides which
// existing Person it is, which other Persons it proves are the same client,
// and what the surviving Person should now know. The store applies it.

export type Contact = {
  pipedrive_id?: number | null;
  /** E.164, already normalised. */
  phone?: string | null;
  /** Lower-cased. */
  email?: string | null;
  name?: string | null;
};

export type KnownPerson = {
  id: string;
  name: string;
  pipedrive_id: number | null;
  phones: string[];
  emails: string[];
};

export type Resolution = {
  /** The Person this contact is, or null when nobody matched (create one from `updates`). */
  winner: KnownPerson | null;
  /** Other Persons that turned out to be the same client: fold them into the winner. */
  absorb: KnownPerson[];
  /** What the winner (or the new Person) should carry afterwards. */
  updates: { name: string; pipedrive_id: number | null; phones: string[]; emails: string[] };
};

function uniq(xs: (string | null | undefined)[]): string[] {
  return [...new Set(xs.filter((x): x is string => !!x))];
}

/**
 * Resolution order: CRM person id → phone → email. A CRM id is the strongest
 * proof, so when it matches one Person and the phone or email matches another,
 * the CRM-backed Person wins and the others are absorbed. With no CRM match,
 * the phone wins over the email the same way.
 */
export function resolvePerson(known: KnownPerson[], contact: Contact): Resolution {
  // A Person already tied to a different CRM record is a different client, even if they share a phone.
  const compatible = (k: KnownPerson) => !(contact.pipedrive_id && k.pipedrive_id && k.pipedrive_id !== contact.pipedrive_id);
  const byCrm = contact.pipedrive_id ? known.filter((k) => k.pipedrive_id === contact.pipedrive_id) : [];
  const byPhone = contact.phone ? known.filter((k) => compatible(k) && k.phones.includes(contact.phone!)) : [];
  const byEmail = contact.email ? known.filter((k) => compatible(k) && k.emails.includes(contact.email!)) : [];

  const ordered = [...byCrm, ...byPhone, ...byEmail];
  const winner = ordered[0] ?? null;
  const absorb = uniqPeople(ordered.slice(1)).filter((k) => k.id !== winner?.id);
  // A Person that already has a different CRM id is a different client: never absorb it.
  const safeAbsorb = absorb.filter((k) => !(k.pipedrive_id && winner?.pipedrive_id && k.pipedrive_id !== winner.pipedrive_id));

  const all = winner ? [winner, ...safeAbsorb] : [];
  const updates = {
    name: pickName(contact.name, winner, safeAbsorb),
    pipedrive_id: contact.pipedrive_id ?? winner?.pipedrive_id ?? safeAbsorb.find((k) => k.pipedrive_id)?.pipedrive_id ?? null,
    phones: uniq([...all.flatMap((k) => k.phones), contact.phone]),
    emails: uniq([...all.flatMap((k) => k.emails), contact.email]),
  };
  return { winner, absorb: safeAbsorb, updates };
}

function uniqPeople(ps: KnownPerson[]): KnownPerson[] {
  const seen = new Set<string>();
  return ps.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

/** A real name beats a placeholder ("Unknown (+61…)"); the CRM's name beats a guessed one. */
function pickName(fromContact: string | null | undefined, winner: KnownPerson | null, absorb: KnownPerson[]): string {
  const candidates = [fromContact, winner?.name, ...absorb.map((k) => k.name)].filter((n): n is string => !!n && n.trim().length > 0);
  return candidates.find((n) => !isPlaceholderName(n)) ?? candidates[0] ?? "Unknown";
}

export function isPlaceholderName(name: string): boolean {
  return /^unknown\b/i.test(name.trim());
}

/** The stand-in name for a client we only know by a number or an address. */
export function placeholderName(contact: Contact): string {
  return `Unknown (${contact.phone ?? contact.email ?? "no contact"})`;
}
