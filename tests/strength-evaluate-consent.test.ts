// Strength history "Evaluate with Ask APEX": the workout is only sent with the signed-in account's stored "Share workout" permission.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EMPTY_ASK_STATE, askConsentKey, askConsentView, loadAskConsent, saveAskConsent, type AskConsent, type AskConsentState,
} from "../lib/strength/askConsentStore.ts";
import { validUid, type ConsentStorage } from "../lib/coach/consentStore.ts";
import { ConsentOwnerMismatch, consentRequestHeaders } from "../lib/consentOwner.ts";

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
class Mem implements ConsentStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
/** The history page: useAskConsent + evaluate() exactly as written. `sent` records every /api/coach request that would be made. */
class Page {
  state: AskConsentState = EMPTY_ASK_STATE; loading = true; sessionUid: string | null = null; last: string | null | undefined = undefined;
  sent: Array<{ cats: string[]; owner: string }> = [];
  storage: ConsentStorage;
  constructor(storage: ConsentStorage) { this.storage = storage; }
  uid() { return this.loading ? null : validUid(this.sessionUid); }
  view() { return askConsentView(this.state, this.uid()); }
  effect() { const u = this.uid(); if (u !== this.last) { this.last = u; this.state = loadAskConsent(this.storage, u); } }
  auth(u: string | null) { this.loading = false; this.sessionUid = u; }
  set(c: AskConsent) { const s = saveAskConsent(this.storage, this.state, this.uid(), c); if (s) this.state = s; }
  evaluate() {
    const v = this.view();
    if (!v.ready || !v.consent.strength || !v.owner) return false;
    this.sent.push({ cats: ["strength"], owner: v.owner }); return true;
  }
}
const grant = (p: Page, uid: string, c: Partial<AskConsent> = {}) => { p.auth(uid); p.effect(); p.set({ strength: true, profile: false, speak: false, ...c }); };

test("permission granted: the workout is sent, naming the consent owner", () => {
  const p = new Page(new Mem()); grant(p, A);
  assert.equal(p.evaluate(), true); assert.deepEqual(p.sent, [{ cats: ["strength"], owner: A }]);
  assert.deepEqual(consentRequestHeaders(p.sent[0].cats, p.sent[0].owner, A), { "X-Consent-User": A, "X-Coach-Consent": "yes" });
});

test("permission denied, never asked, or only other options on: nothing is sent", () => {
  const p = new Page(new Mem()); p.auth(A); p.effect();
  assert.equal(p.evaluate(), false, "default: not granted");
  p.set({ strength: false, profile: true, speak: true }); assert.equal(p.evaluate(), false, "profile/speak do not grant workout sharing");
  p.set({ strength: true, profile: false, speak: false }); p.set({ strength: false, profile: false, speak: false }); assert.equal(p.evaluate(), false, "withdrawn");
  assert.equal(p.sent.length, 0);
});

test("malformed or foreign stored consent denies", () => {
  for (const raw of ["{", "null", JSON.stringify({ strength: true }), JSON.stringify({ uid: B, strength: true, profile: false, speak: false }), JSON.stringify({ uid: A, strength: "yes" })]) {
    const s = new Mem(); s.setItem(askConsentKey(A), raw);
    const p = new Page(s); p.auth(A); p.effect(); assert.equal(p.evaluate(), false, raw);
  }
});

test("loading state: nothing is sent while auth or this account's consent is loading", () => {
  const s = new Mem(); s.setItem(askConsentKey(A), JSON.stringify({ uid: A, strength: true, profile: false, speak: false }));
  const p = new Page(s);
  assert.equal(p.evaluate(), false, "auth loading"); p.effect(); assert.equal(p.evaluate(), false);
  p.sessionUid = A; assert.equal(p.evaluate(), false, "session present, auth still loading");
  p.auth(A); assert.equal(p.evaluate(), false, "signed in, consent not loaded yet");
  p.effect(); assert.equal(p.evaluate(), true);
});

test("account switching: A's permission never applies to B; request names the owner; the other account's token is rejected", () => {
  const p = new Page(new Mem()); grant(p, A);
  p.auth(B);                                                    // switched in another tab, effect not run yet
  assert.equal(p.evaluate(), false, "A's loaded permission is not exposed for B");
  const sentBefore = p.sent.length;
  p.effect(); assert.equal(p.evaluate(), false, "B has not granted");
  assert.equal(p.sent.length, sentBefore);
  p.set({ strength: true, profile: false, speak: false }); assert.equal(p.evaluate(), true); assert.equal(p.sent.at(-1)!.owner, B);
  p.auth(null); p.effect(); assert.equal(p.evaluate(), false);
  p.auth(A); p.effect(); assert.equal(p.evaluate(), true); assert.equal(p.sent.at(-1)!.owner, A, "A gets back only A's own choice");
  // B's token with A's consent owner (stale tab): refused before sending.
  assert.throws(() => consentRequestHeaders(["strength"], A, B), ConsentOwnerMismatch);
});

test("wiring: the page uses the Ask APEX store, gates the request, and sends the consent owner", () => {
  const src = readFileSync(new URL("../app/(app)/strength/history/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(src, /const askC = useAskConsent\(\)/);
  assert.match(src, /if \(!w \|\| !askC\.ready \|\| !askC\.consent\.strength \|\| !askC\.owner\) return;/);
  assert.match(src, /\["strength"\], askC\.owner\)/);
  assert.ok(!/session\?\.user\?\.id/.test(src.slice(src.indexOf("async function evaluate"), src.indexOf("if (state === \"loading\")"))), "never the current session id");
  assert.match(src, /disabled=\{!askC\.ready \|\| !askC\.consent\.strength \|\| ai\.busy\}/);
  assert.ok(!/ai\.consent/.test(src), "no separate page-level consent");
  const hook = readFileSync(new URL("../components/strength/useAskConsent.ts", import.meta.url), "utf8");
  assert.match(hook, /const uid = loading \? null : validUid\(session\?\.user\?\.id\)/);
  assert.match(hook, /askConsentView\(state, uid\)/);
});
