// Ask APEX consent is scoped to the signed-in account (same rules as the Coach consent). Synthetic ids only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ASK_LEGACY_KEY, EMPTY_ASK_STATE, NO_ASK_CONSENT, askConsentKey, askConsentView, loadAskConsent, parseAskConsent, saveAskConsent,
  type AskConsent, type AskConsentState,
} from "../lib/strength/askConsentStore.ts";
import { validUid, type ConsentStorage } from "../lib/coach/consentStore.ts";
import { ConsentOwnerMismatch, assertConsentOwner, consentRequestHeaders } from "../lib/consentOwner.ts";

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const GRANT: AskConsent = { strength: true, profile: true, speak: false };
class Mem implements ConsentStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
/** A mounted AskApex: exactly the calls the component makes. */
class Mounted {
  state: AskConsentState = EMPTY_ASK_STATE; loading = true; sessionUid: string | null = null; last: string | null | undefined = undefined;
  storage: ConsentStorage | null;
  constructor(storage: ConsentStorage | null) { this.storage = storage; }
  uid() { return this.loading ? null : validUid(this.sessionUid); }
  view() { return askConsentView(this.state, this.uid()); }
  effect() { const u = this.uid(); if (u !== this.last) { this.last = u; this.state = loadAskConsent(this.storage, u); } }
  auth(u: string | null) { this.loading = false; this.sessionUid = u; }
  set(c: AskConsent) { const s = saveAskConsent(this.storage, this.state, this.uid(), c); if (s) this.state = s; }
  /** What ask() does: nothing is sent unless consent is ready; the request carries the consent owner, not the current session. */
  request(): { cats: string[]; owner: string | null } | "blocked" {
    const v = this.view(); if (!v.ready) return "blocked";
    return { cats: [...(v.consent.strength ? ["strength"] : []), ...(v.consent.profile ? ["profile"] : [])], owner: v.owner };
  }
}

test("user A grants consent and signs out: gone from memory at once", () => {
  const m = new Mounted(new Mem()); m.auth(A); m.effect(); m.set(GRANT);
  assert.deepEqual(m.request(), { cats: ["strength", "profile"], owner: A });
  m.auth(null);
  assert.deepEqual(m.view(), { consent: NO_ASK_CONSENT, ready: false, owner: null }); assert.equal(m.request(), "blocked");
  m.effect(); assert.deepEqual(m.state, EMPTY_ASK_STATE);
});

test("user B on the same browser inherits nothing; A signing back in gets only A's consent", () => {
  const s = new Mem(), m = new Mounted(s);
  m.auth(A); m.effect(); m.set(GRANT); m.auth(null); m.effect();
  m.auth(B); assert.equal(m.request(), "blocked"); m.effect();
  assert.deepEqual(m.request(), { cats: [], owner: B });
  m.set({ strength: false, profile: false, speak: true }); m.auth(null); m.effect();
  m.auth(A); m.effect(); assert.deepEqual(m.request(), { cats: ["strength", "profile"], owner: A });
  m.auth(B); m.effect(); assert.deepEqual(m.request(), { cats: [], owner: B });
  assert.equal(m.view().consent.speak, true);
});

test("account switch while mounted: A's consent is never exposed for B, and a change before B's loads is ignored", () => {
  const m = new Mounted(new Mem()); m.auth(A); m.effect(); m.set(GRANT);
  m.auth(B);
  assert.equal(m.state.uid, A); assert.deepEqual(m.view(), { consent: NO_ASK_CONSENT, ready: false, owner: null });
  m.set({ strength: true, profile: true, speak: true }); assert.equal(m.state.uid, A, "ignored, not written under either account");
  m.effect(); assert.deepEqual(m.request(), { cats: [], owner: B });
});

test("the legacy shared value is discarded, not migrated", () => {
  const s = new Mem(); s.setItem(ASK_LEGACY_KEY, JSON.stringify(GRANT));
  const st = loadAskConsent(s, B);
  assert.deepEqual(st.consent, NO_ASK_CONSENT); assert.equal(s.getItem(ASK_LEGACY_KEY), null); assert.equal(s.getItem(askConsentKey(B)), null);
});

test("no AI request while auth or consent is loading; missing/foreign/invalid values fail closed", () => {
  const s = new Mem(); s.setItem(askConsentKey(A), JSON.stringify({ uid: A, ...GRANT }));
  const m = new Mounted(s);
  assert.equal(m.request(), "blocked"); m.effect(); assert.equal(m.request(), "blocked");
  m.sessionUid = A; assert.equal(m.request(), "blocked", "session present but auth still loading");
  m.auth(A); assert.equal(m.request(), "blocked", "signed in, consent not loaded yet");
  m.effect(); assert.notEqual(m.request(), "blocked");
  for (const raw of [null, "", "{", "null", JSON.stringify(GRANT), JSON.stringify({ uid: B, ...GRANT })]) assert.deepEqual(parseAskConsent(raw, A), NO_ASK_CONSENT, String(raw));
  for (const u of [null, undefined, "", "not-a-uuid"]) {
    assert.deepEqual(loadAskConsent(s, u as string), EMPTY_ASK_STATE); assert.equal(saveAskConsent(s, EMPTY_ASK_STATE, u as string, GRANT), null);
  }
  const bad: ConsentStorage = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); }, removeItem() { throw new Error("x"); } };
  assert.deepEqual(loadAskConsent(bad, A), { uid: A, consent: NO_ASK_CONSENT });
});

test("a request carrying another account's consent owner is rejected (client and server)", () => {
  const m = new Mounted(new Mem()); m.auth(A); m.effect(); m.set(GRANT);
  const req = m.request() as { cats: string[]; owner: string | null };
  // Another tab signed in as B: B's verified session, A's consent owner.
  assert.throws(() => consentRequestHeaders(req.cats, req.owner, B), ConsentOwnerMismatch);
  assert.throws(() => assertConsentOwner(new Headers({ "x-consent-user": A }), B), (e: unknown) => e instanceof ConsentOwnerMismatch && e.status === 403);
  assert.doesNotThrow(() => assertConsentOwner(new Headers(consentRequestHeaders(req.cats, req.owner, A)), A));
});

test("wiring: AskApex uses the account-scoped store and sends the consent owner", () => {
  const src = readFileSync(new URL("../components/strength/AskApex.tsx", import.meta.url), "utf8");
  assert.ok(!/apex-askapex-consent-v1/.test(src) && !/localStorage\.(get|set)Item/.test(src), "no direct or shared-key storage");
  assert.match(src, /const uid = loading \? null : validUid\(session\?\.user\?\.id\)/);
  assert.match(src, /useEffect\(\(\) => \{ setState\(loadAskConsent\(storage\(\), uid\)\); \}, \[uid\]\)/);
  assert.match(src, /askConsentView\(state, uid\)/);
  assert.match(src, /if \(!consentReady\) \{[^}]*\}[^\n]*\n\s*setMsgs\(\(m\) => \[\.\.\.m, \{ role: "user", text: q \}\]\);\s*\n\s*setBusy\(true\)/, "consent check precedes the AI request");
  assert.match(src, /, cats, consentOwner\);/);
  assert.ok(!/session\?\.user\?\.id\s*\?\?\s*null\)/.test(src), "never the current session id");
});
