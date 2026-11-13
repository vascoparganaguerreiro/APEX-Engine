// Public Privacy Policy and Terms pages: public (no auth, outside the signed-in layout), linked from login and Profile → Account,
// honest about what exists today, and every unverified fact is a visible placeholder. Source-level checks; the build and a signed-out
// request against the built server cover actual rendering.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { CONTACT_EMAIL, LEGAL_PLACEHOLDERS } from "../lib/legal.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const privacy = read("app/privacy/page.tsx"), terms = read("app/terms/page.tsx"), shared = read("components/legal/Legal.tsx");
const flat = (s: string) => s.replace(/\s+/g, " ");

test("both routes are public: outside the authenticated (app) group, no auth, Supabase, client hooks or redirects", () => {
  assert.ok(existsSync(new URL("../app/privacy/page.tsx", import.meta.url)) && existsSync(new URL("../app/terms/page.tsx", import.meta.url)));
  assert.ok(!existsSync(new URL("../app/(app)/privacy", import.meta.url)) && !existsSync(new URL("../app/(app)/terms", import.meta.url)));
  for (const src of [privacy, terms, shared]) {
    assert.ok(!/use client/.test(src), "server-rendered");
    assert.ok(!/useAuth|getSupabase|supabase|redirect\(|useRouter|localStorage/.test(src), "nothing that needs a session");
  }
  assert.ok(!existsSync(new URL("../middleware.ts", import.meta.url)) && !existsSync(new URL("../proxy.ts", import.meta.url)), "no request gate that could block signed-out visitors");
  const layout = read("app/layout.tsx");
  assert.ok(!/useAuth|getSupabase/.test(layout), "the root layout does not require a session");
});

test("login and Profile → Account link to both pages", () => {
  assert.match(shared, /href="\/privacy"/); assert.match(shared, /href="\/terms"/);
  assert.match(shared, /export function LegalLinks/);
  const login = read("app/login/page.tsx"), profile = read("app/(app)/profile/page.tsx");
  assert.match(login, /import \{ LegalLinks \}/); assert.match(login, /<LegalLinks \/>/);
  assert.match(profile, /import \{ LegalLinks \}/);
  const account = profile.slice(profile.indexOf('id="profile-account"'), profile.indexOf("</section>", profile.indexOf('id="profile-account"')));
  assert.match(account, /<LegalLinks \/>/, "inside the Account section");
  assert.ok(privacy.includes('href="/terms"') || /Terms of Use/.test(shared), "the pages link to each other");
  assert.match(terms, /href="\/privacy"/);
});

test("the operator is an individual project operator with the temporary contact, never a company", () => {
  assert.equal(CONTACT_EMAIL, "apexengine.project@gmail.com");
  for (const src of [privacy, terms]) {
    assert.ok(flat(src).includes("CONTACT_EMAIL") || src.includes(CONTACT_EMAIL));
    assert.match(flat(src), /one individual/);
    assert.ok(!/\b(Ltd|Inc\.|LLC|GmbH|Lda|S\.A\.|registered office|our company|the company)\b/i.test(src.replace(/not by a company|not a company|not by the company/gi, "")), "no invented company identity");
  }
  assert.match(flat(privacy), /no registered business name, postal address or data protection officer/);
});

test("privacy policy covers the required topics and is accurate about current export and deletion limits", () => {
  const p = flat(privacy);
  for (const topic of ["special category", "Supabase", "Vercel", "Gemini", "Intervals.icu", "WHOOP", "How long data is kept", "Security", "Your rights", "On your device", "Legal basis"]) assert.ok(p.includes(topic), `mentions ${topic}`);
  assert.match(p, /Deleting your whole account is not available in the app/);
  assert.match(p, /A complete export of all your data is not available in the app/);
  assert.ok(!/you can (delete|erase) your (whole |entire )?account|download all your data|export all your data (from|in) the app/i.test(p), "no claim that those features exist");
  assert.match(p, /does not claim that it alone makes the processing compliant/);
  assert.ok(!/GDPR[- ]compliant|fully compliant|certified|ISO 27001|SOC 2|end-to-end encrypt|guarantee/i.test(p.replace(/does not claim[^.]*\./, "").replace(/no independent security audit or certification/, "").replace(/removal of the file is not guaranteed/, "")), "no unsupported assurances");
  assert.ok(!/\b\d+ (days|months|years)\b/i.test(p), "no invented retention periods");
  assert.match(p, /I have not added analytics, advertising or tracking tools/);
});

test("terms say it is a beta, not medical advice, and that account deletion and full export are not yet in the app", () => {
  const t = flat(terms);
  assert.match(t, /Not medical advice/); assert.match(t, /does not diagnose, treat or prevent/);
  assert.match(t, /private-beta/); assert.match(t, /Access is by invitation only/);
  assert.match(t, /Deleting your whole account and exporting all your data are not yet available inside the app/);
});

test("every unverified fact is a visible placeholder, and the placeholder list matches the pages", () => {
  const used = new Set([...(privacy + terms).matchAll(/<Todo id="([a-z0-9-]+)"/g)].map((m) => m[1]));
  for (const id of used) assert.ok(LEGAL_PLACEHOLDERS.some((x) => x.id === id), `unknown placeholder ${id}`);
  for (const x of LEGAL_PLACEHOLDERS) assert.ok(used.has(x.id), `placeholder ${x.id} is listed but not on a page`);
  assert.match(shared, /className="legal-todo"/);
  assert.match(shared, /DRAFT: not approved for external beta use/); assert.match(shared, /role="note"/);
  assert.ok(/<LegalPage/.test(privacy) && /<LegalPage/.test(terms), "both pages use the shell that shows the draft warning");
  for (const id of ["operator-name", "article-9-basis", "retention", "processors"]) assert.ok(used.has(id as never));
});

test("claims about integrations match the code: direct connections only for Intervals.icu and WHOOP", () => {
  const providers = read("lib/integrations/providers.ts");
  assert.match(providers, /id: "whoop"[^]*?kind: "direct"/); assert.match(providers, /id: "intervals"[^]*?kind: "direct"/);
  assert.match(providers, /id: "oura"[^]*?kind: "unsupported"/);
  assert.match(flat(privacy), /Apple Health, Samsung Health and Oura are not connected/);
  assert.ok(!/analytics|sentry|posthog|gtag/i.test(read("package.json")), "no analytics dependency, as the policy states");
});

test("review corrections: no unverified security claims, accurate identity-field, log, offline, deletion and Vercel wording", () => {
  const p = flat(privacy), t = flat(terms);
  assert.ok(!/never sent/.test(p), "no absolute 'never sent' claim");
  assert.match(p, /structured Coach and summary requests leave out your email address, name, date of birth and credentials/);
  assert.match(p, /sent to Gemini exactly as you uploaded it/); assert.match(p, /sent as you wrote it/);
  assert.match(p, /I have not yet verified the same rules for the older core tables \(activities, daily metrics, profile and races\), so I make no claim about them/);
  assert.match(p, /you can read and delete them but not edit them/);
  assert.ok(!/Your records are protected by per-user access rules/.test(p));
  assert.match(p, /There is no service worker; the on-device data described above is the only offline storage/);
  assert.ok(!/no service worker or offline cache of personal data/.test(p));
  assert.match(p, /designed to avoid passwords, keys and token values/); assert.match(p, /hosting providers also keep their own logs/);
  assert.match(p, /also tries to remove its uploaded report file, but removal of the file is not guaranteed/);
  assert.ok(/<b>Vercel<\/b>[^]*?<Todo id="processors">need to be confirmed<\/Todo>/.test(privacy), "Vercel's role is an unresolved placeholder");
  assert.match(t, /It is not intended to be used as a medical device/); assert.ok(!/It is not a medical device/.test(t));
  assert.ok(/medical device[^]*?<Todo id="liability">/.test(terms), "the medical-device wording is flagged for legal review");
  assert.ok(LEGAL_PLACEHOLDERS.find((x) => x.id === "operator-name")!.what.includes("postal address or other contact details must be published"));
  assert.ok(LEGAL_PLACEHOLDERS.find((x) => x.id === "liability")!.what.includes("medical device"));
  assert.equal(LEGAL_PLACEHOLDERS.length, 8);
  assert.ok(!/we guarantee|fully secure|compliant with the GDPR/i.test(p.replace(/does not claim[^.]*\./, "")));
});
