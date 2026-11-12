// Task 7B.2: Coach consent is scoped to the signed-in account. One account's consent can never be loaded for another on the same browser.
// The account transitions are simulated with the exact functions useConsent (components/coach/consent.tsx) runs. Synthetic ids only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EMPTY_CONSENT_STATE, LEGACY_CONSENT_KEY, NO_CONSENT, authorizedOf, consentKey, consentView, loadConsentState, parseConsent,
  saveConsentState, validUid, type Consent, type ConsentState, type ConsentStorage,
} from "../lib/coach/consentStore.ts";

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const WELLNESS: Consent = { accepted: true, categories: ["activities", "wellness", "load"] };

class MemStorage implements ConsentStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

/** A mounted useConsent: `auth` is what useAuth reports; render() is what components see; effect() is the [uid] effect. */
class Mounted {
  storage: ConsentStorage | null;
  state: ConsentState = EMPTY_CONSENT_STATE;
  loading = true;
  sessionUid: string | null = null;
  lastEffectUid: string | null | undefined = undefined;
  constructor(storage: ConsentStorage | null) { this.storage = storage; }
  uid() { return this.loading ? null : validUid(this.sessionUid); }
  render() { return consentView(this.state, this.uid()); }
  effect() { const u = this.uid(); if (u !== this.lastEffectUid) { this.lastEffectUid = u; this.state = loadConsentState(this.storage, u); } }
  auth(uid: string | null) { this.loading = false; this.sessionUid = uid; }
  save(c: Consent) { const s = saveConsentState(this.storage, this.state, this.uid(), c); if (s) this.state = s; }
  /** What the pages do before any AI request: refuse unless consent is ready; send only authorizedOf(consent). */
  aiRequest(): string[] | "blocked" { const v = this.render(); return v.ready ? authorizedOf(v.consent) : "blocked"; }
}

test("user A grants consent and signs out: A's consent is gone from memory at once", () => {
  const s = new MemStorage(), m = new Mounted(s);
  m.auth(A); m.effect(); m.save(WELLNESS);
  assert.deepEqual(m.aiRequest(), ["activities", "wellness", "load"]);
  assert.ok(s.getItem(consentKey(A)), "stored under A's own key");
  m.auth(null);                                                          // sign-out: same render, before any effect
  assert.deepEqual(m.render(), { consent: NO_CONSENT, ready: false });
  assert.equal(m.aiRequest(), "blocked");
  m.effect();
  assert.deepEqual(m.state, EMPTY_CONSENT_STATE, "in-memory consent cleared");
});

test("user B signs in on the same browser and inherits nothing from A", () => {
  const s = new MemStorage(), m = new Mounted(s);
  m.auth(A); m.effect(); m.save(WELLNESS); m.auth(null); m.effect();
  m.auth(B);
  assert.equal(m.aiRequest(), "blocked", "before B's consent is loaded nothing can be sent");
  m.effect();
  assert.deepEqual(m.render(), { consent: NO_CONSENT, ready: true });
  assert.deepEqual(m.aiRequest(), [], "B shares nothing until B chooses");
});

test("direct account switch A -> B while mounted (no sign-out in between): A's consent is never exposed for B", () => {
  const m = new Mounted(new MemStorage());
  m.auth(A); m.effect(); m.save(WELLNESS);
  m.auth(B);                                                             // auth change while mounted; state still holds A's record
  assert.equal(m.state.uid, A);
  assert.deepEqual(m.render(), { consent: NO_CONSENT, ready: false }, "the view is keyed to the current uid");
  m.save({ accepted: true, categories: ["races"] });
  assert.equal(m.state.uid, A, "a change made before B's consent loaded is ignored, not written under either account");
  m.effect();
  assert.deepEqual(m.aiRequest(), []);
});

test("user A signs back in: only A's own consent is loaded (kept per account on this browser)", () => {
  const s = new MemStorage(), m = new Mounted(s);
  m.auth(A); m.effect(); m.save(WELLNESS); m.auth(null); m.effect();
  m.auth(B); m.effect(); m.save({ accepted: true, categories: ["races"] }); m.auth(null); m.effect();
  m.auth(A); m.effect();
  assert.deepEqual(m.aiRequest(), ["activities", "wellness", "load"]);
  m.auth(B); m.effect();
  assert.deepEqual(m.aiRequest(), ["races"]);
});

test("missing or malformed user id: no consent, not ready, nothing read or written", () => {
  for (const uid of [null, undefined, "", "not-a-uuid", "../apex", 42]) {
    const s = new MemStorage(); s.setItem(consentKey(A), JSON.stringify({ uid: A, ...WELLNESS }));
    assert.deepEqual(loadConsentState(s, uid as string), EMPTY_CONSENT_STATE);
    assert.deepEqual(consentView(loadConsentState(s, uid as string), uid as string), { consent: NO_CONSENT, ready: false });
    assert.equal(saveConsentState(s, EMPTY_CONSENT_STATE, uid as string, WELLNESS), null);
    assert.deepEqual([...s.m.keys()], [consentKey(A)]);
  }
});

test("no AI request can proceed while auth or consent is loading", () => {
  const s = new MemStorage(); s.setItem(consentKey(A), JSON.stringify({ uid: A, ...WELLNESS }));
  const m = new Mounted(s);
  assert.equal(m.aiRequest(), "blocked", "auth still loading");
  m.effect(); assert.equal(m.aiRequest(), "blocked", "auth still loading after the first effect");
  m.sessionUid = A;                                                       // a session object may exist while useAuth is still loading
  assert.equal(m.aiRequest(), "blocked");
  m.auth(A); assert.equal(m.aiRequest(), "blocked", "signed in, consent not loaded yet");
  m.effect(); assert.deepEqual(m.aiRequest(), ["activities", "wellness", "load"]);
});

test("logout/login transitions: token refresh keeps consent; every real account change resets it", () => {
  const m = new Mounted(new MemStorage());
  m.auth(A); m.effect(); m.save(WELLNESS);
  m.auth(A); m.effect();                                                  // TOKEN_REFRESHED: same uid
  assert.deepEqual(m.aiRequest(), ["activities", "wellness", "load"]);
  m.auth(A.toUpperCase()); assert.equal(m.render().ready, true, "the same uuid in another case is the same account");
  for (const next of [null, B, null, A]) {
    m.auth(next);
    assert.equal(m.render().ready, false, `right after switching to ${next}`);
    m.effect();
  }
  assert.deepEqual(m.aiRequest(), ["activities", "wellness", "load"]);
});

test("the old shared key is never read or migrated, and is removed", () => {
  const s = new MemStorage();
  s.setItem(LEGACY_CONSENT_KEY, JSON.stringify(WELLNESS));
  const st = loadConsentState(s, B);
  assert.deepEqual(st.consent, NO_CONSENT);
  assert.equal(s.getItem(LEGACY_CONSENT_KEY), null);
  assert.equal(s.getItem(consentKey(B)), null, "nothing copied to the account");
});

test("missing, invalid, foreign or unavailable consent fails closed", () => {
  for (const raw of [null, "", "{", "null", "[]", JSON.stringify(WELLNESS) /* no owner */, JSON.stringify({ uid: B, ...WELLNESS }) /* B's value under A's key */,
    JSON.stringify({ uid: A, accepted: "yes", categories: ["wellness"] }), JSON.stringify({ uid: A, accepted: true, categories: "wellness" })]) {
    assert.deepEqual(parseConsent(raw, A), NO_CONSENT, String(raw));
  }
  assert.deepEqual(parseConsent(JSON.stringify({ uid: A, accepted: true, categories: ["wellness", "strength", "bogus", "wellness"] }), A), { accepted: true, categories: ["wellness"] }, "unknown and strength categories are dropped");
  assert.deepEqual(authorizedOf(parseConsent(JSON.stringify({ uid: A, accepted: false, categories: ["wellness"] }), A)), [], "not accepted: nothing sent");
  const throwing: ConsentStorage = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); }, removeItem() { throw new Error("x"); } };
  assert.deepEqual(loadConsentState(throwing, A), { uid: A, consent: NO_CONSENT });
  assert.deepEqual(loadConsentState(null, A), { uid: A, consent: NO_CONSENT });
  assert.ok(saveConsentState(throwing, { uid: A, consent: NO_CONSENT }, A, WELLNESS), "a failed write keeps the choice for this page only");
});

test("wiring: the hook keys consent to the signed-in uid; pages refuse AI requests until it is ready", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const hook = read("components/coach/consent.tsx");
  assert.match(hook, /const uid = loading \? null : validUid\(session\?\.user\?\.id\)/);
  assert.match(hook, /consentView\(state, uid\)/);
  assert.match(hook, /useEffect\(\(\) => \{ setState\(loadConsentState\(storage\(\), uid\)\); \}, \[uid\]\)/);
  assert.ok(!/localStorage\.(get|set)Item\(\s*["'`]apex\.coach\.consent\.v1["'`]/.test(hook), "the shared key is not used");
  const acts = read("app/(app)/activities/page.tsx");
  assert.equal((acts.match(/if \(!consentReady\) \{ setInfo\(LOADING_CONSENT\); return; \}/g) ?? []).length, 2, "both summary actions wait for consent");
  const coach = read("app/(app)/coach/page.tsx");
  for (const t of ["session", "daily", "ask", "plan"]) assert.match(coach, new RegExp(`consentReady && tab === "${t}"`));
  assert.match(coach, /async function analyzeDaily\(\) \{\s*if \(!consentReady\) return;/);
  assert.match(read("components/today/CoachInsight.tsx"), /const canRun = ready && authorized\.length > 0/);
});
