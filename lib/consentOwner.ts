// Account-consistency check for every AI request that carries consent (Coach, Ask APEX, activity and weekly summaries). No imports.
//
// The browser sends the user id the consent was loaded for (X-Consent-User). The server compares it with the user id of the VERIFIED
// Supabase session and rejects a mismatch (or a missing / malformed id) with 403 before reading any personal data or calling the AI.
// This catches a sign-in to another account in another tab: the request would carry account B's token with account A's consent.
// It is NOT proof of consent: the id is not a secret and any client can send its own. Consent itself is still the category list plus
// X-Coach-Consent, checked as before.

export const CONSENT_USER_HEADER = "X-Consent-User";
export const ACCOUNT_MISMATCH_MESSAGE = "You signed in to a different account in another tab. Reload this page, check what you share with the AI, then try again.";

export class ConsentOwnerMismatch extends Error {
  status = 403;
  constructor() { super(ACCOUNT_MISMATCH_MESSAGE); this.name = "ConsentOwnerMismatch"; }
}

const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const norm = (v: unknown): string | null => (typeof v === "string" && UID.test(v.trim()) ? v.trim().toLowerCase() : null);

/** True only when both ids are valid and name the same account. */
export function sameAccount(consentUser: unknown, sessionUser: unknown): boolean {
  const a = norm(consentUser), b = norm(sessionUser);
  return a !== null && a === b;
}

/** Server side: call right after the session is verified, before anything else. Throws ConsentOwnerMismatch (403). */
export function assertConsentOwner(headers: { get(name: string): string | null }, verifiedUid: string): void {
  if (!sameAccount(headers.get(CONSENT_USER_HEADER), verifiedUid)) throw new ConsentOwnerMismatch();
}

/** Client side: the headers for a consent-bearing request. Throws (nothing is sent) when the signed-in session is not the account the
 *  consent was loaded for, or when that account is unknown (consent still loading). */
export function consentRequestHeaders(categories: readonly string[], consentUser: string | null | undefined, sessionUser: string | null | undefined): Record<string, string> {
  if (!sameAccount(consentUser, sessionUser)) throw new ConsentOwnerMismatch();
  return { [CONSENT_USER_HEADER]: String(consentUser).trim().toLowerCase(), ...(categories.length ? { "X-Coach-Consent": "yes" } : {}) };
}
