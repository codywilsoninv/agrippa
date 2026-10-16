// Messaging module: phone number normalisation. PURE, no imports.
//
// Texts arrive with the number in whatever shape the carrier or the CRM used
// ("0412 345 678", "61412345678", "+61 412 345 678"). Everything is compared in
// E.164 so one client is one thread. The default country is a setting of the
// business, not a constant of the module.

export type CountryCode = "AU";

const COUNTRY: Record<CountryCode, { dial: string; trunk: string; nationalLength: number }> = {
  // Australian numbers: 10 digits with the trunk 0 (04xx mobiles, 02/03/07/08 landlines), 9 without.
  AU: { dial: "61", trunk: "0", nationalLength: 9 },
};

/** E.164 ("+61412345678") or null when the input can't be a phone number. */
export function toE164(raw: string | null | undefined, defaultCountry: CountryCode = "AU"): string | null {
  if (!raw) return null;
  const hasPlus = raw.trim().startsWith("+");
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2); // international prefix
  if (digits.length < 6) return null;

  const c = COUNTRY[defaultCountry];
  if (hasPlus) return `+${digits}`;
  // Already in international form without the plus ("61412345678").
  if (digits.startsWith(c.dial) && digits.length === c.dial.length + c.nationalLength) return `+${digits}`;
  // National form with the trunk prefix ("0412345678").
  if (digits.startsWith(c.trunk) && digits.length === c.trunk.length + c.nationalLength) return `+${c.dial}${digits.slice(c.trunk.length)}`;
  // National form without the trunk ("412345678").
  if (digits.length === c.nationalLength) return `+${c.dial}${digits}`;
  // Something else with a plausible length: assume it's already international.
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** True when two raw numbers are the same subscriber. */
export function samePhone(a: string | null | undefined, b: string | null | undefined, defaultCountry: CountryCode = "AU"): boolean {
  const x = toE164(a, defaultCountry);
  const y = toE164(b, defaultCountry);
  return x !== null && x === y;
}

/** The national significant number ("412345678"): what a CRM phone search matches on whatever the stored format. */
export function searchDigits(e164: string, defaultCountry: CountryCode = "AU"): string {
  const c = COUNTRY[defaultCountry];
  const digits = e164.replace(/\D/g, "");
  return digits.startsWith(c.dial) ? digits.slice(c.dial.length) : digits;
}

/** "+61…678": enough to recognise a number on screen without printing it whole in logs. */
export function maskPhone(e164: string): string {
  return e164.length > 6 ? `${e164.slice(0, 3)}…${e164.slice(-3)}` : e164;
}
