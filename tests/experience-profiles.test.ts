// Explicit experience profiles: per-account choice, safe fallbacks, Today ordering, nothing hidden, nothing recalculated.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EMPTY_EXPERIENCE_STATE, EXPERIENCES, EXPERIENCE_INFO, experienceKey, experienceView, loadExperienceState, parseExperience, resolveExperience, saveExperienceState,
  type ExperienceStorage,
} from "../lib/experience.ts";
import { LENS_METRICS, LENS_SECTIONS } from "../lib/today/lens.ts";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const mem = (): ExperienceStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};

test("three experiences with the requested focus, each described only with things APEX has", () => {
  assert.deepEqual([...EXPERIENCES], ["performance", "wellness", "longevity"]);
  assert.equal(EXPERIENCE_INFO.performance.label, "Performance"); assert.equal(EXPERIENCE_INFO.wellness.label, "Health & Wellness"); assert.equal(EXPERIENCE_INFO.longevity.label, "Longevity");
  assert.match(EXPERIENCE_INFO.longevity.focus, /no mobility measurement yet/, "no mobility metric is implied or invented");
});

test("a choice is saved per account and read back only for that account", () => {
  const s = mem();
  let st = loadExperienceState(s, A);
  assert.deepEqual(st, { uid: A, choice: null }, "no selection yet: no choice, no error");
  st = saveExperienceState(s, st, A, "longevity")!;
  assert.equal(s.data.get(experienceKey(A)), JSON.stringify({ uid: A, lens: "longevity" }));
  assert.equal(loadExperienceState(s, A).choice, "longevity");
  assert.equal(loadExperienceState(s, B).choice, null, "another account on this browser does not see it");
  assert.equal(s.data.has(experienceKey(B)), false);
});

test("switching accounts or signing out never exposes the previous account's choice", () => {
  const s = mem(); const a = saveExperienceState(s, loadExperienceState(s, A), A, "wellness")!;
  assert.deepEqual(experienceView(a, A), { choice: "wellness", ready: true });
  assert.deepEqual(experienceView(a, B), { choice: null, ready: false }, "after a switch, until B's own choice is loaded");
  assert.deepEqual(experienceView(a, null), { choice: null, ready: false });
  assert.equal(saveExperienceState(s, a, B, "performance"), null, "a change cannot be written under the wrong account");
  assert.equal(s.data.has(experienceKey(B)), false);
  assert.equal(saveExperienceState(s, EMPTY_EXPERIENCE_STATE, null, "performance"), null, "signed out: nothing is written");
  assert.equal(loadExperienceState(s, "not-a-uid"), EMPTY_EXPERIENCE_STATE);
});

test("changing the choice and returning to automatic", () => {
  const s = mem(); let st = loadExperienceState(s, A);
  st = saveExperienceState(s, st, A, "performance")!; st = saveExperienceState(s, st, A, "longevity")!;
  assert.equal(loadExperienceState(s, A).choice, "longevity");
  st = saveExperienceState(s, st, A, null)!;
  assert.equal(st.choice, null); assert.equal(s.data.has(experienceKey(A)), false, "automatic removes the stored choice");
  assert.equal(saveExperienceState(s, st, A, "nonsense" as never), null, "an unknown experience is rejected");
});

test("bad stored data and unavailable storage mean no choice, never a crash", () => {
  for (const raw of [null, "", "{", "[]", "null", '{"uid":"x","lens":"longevity"}', JSON.stringify({ uid: B, lens: "longevity" }), JSON.stringify({ uid: A, lens: "hacker" }), JSON.stringify({ uid: A })]) {
    assert.equal(parseExperience(raw, A), null, String(raw));
  }
  assert.equal(loadExperienceState(null, A).choice, null);
  const broken: ExperienceStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(loadExperienceState(broken, A).choice, null);
  assert.equal(saveExperienceState(broken, loadExperienceState(broken, A), A, "wellness")!.choice, "wellness", "kept for this page when storage fails");
});

test("which view applies: own choice, then the goal, then Performance", () => {
  assert.deepEqual(resolveExperience("longevity", "race_performance"), { lens: "longevity", basis: "chosen" }, "an explicit choice beats the goal");
  assert.deepEqual(resolveExperience(null, "health"), { lens: "longevity", basis: "goal" });
  assert.deepEqual(resolveExperience(null, "general_fitness"), { lens: "wellness", basis: "goal" });
  assert.deepEqual(resolveExperience(null, null), { lens: "performance", basis: "default" }, "no selection and no goal: the layout Today always had");
  assert.deepEqual(resolveExperience(null, undefined), { lens: "performance", basis: "default" });
});

test("each experience prioritises its own modules, and every module is still shown", () => {
  const all = ["biomarkers", "endurance", "race", "strength", "supplements", "wellness"];
  for (const l of EXPERIENCES) assert.deepEqual([...LENS_SECTIONS[l]].sort(), all, `${l}: every card appears exactly once, none hidden`);
  assert.equal(LENS_SECTIONS.performance[0], "endurance"); assert.ok(LENS_SECTIONS.performance.indexOf("race") < LENS_SECTIONS.performance.indexOf("biomarkers"));
  assert.equal(LENS_SECTIONS.wellness[0], "wellness"); assert.ok(LENS_SECTIONS.wellness.indexOf("supplements") < LENS_SECTIONS.wellness.indexOf("race"));
  assert.deepEqual(LENS_SECTIONS.longevity.slice(0, 2), ["biomarkers", "strength"]);
  assert.equal(LENS_METRICS.performance[0], "readiness"); assert.equal(LENS_METRICS.wellness[0], "sleep");
  assert.notDeepEqual(LENS_SECTIONS.performance, LENS_SECTIONS.longevity);
});

test("Today uses the choice and says so; the Profile has the picker; the old goal-only hint is replaced", () => {
  const today = read("app/(app)/today/page.tsx"), picker = read("components/profile/ExperiencePicker.tsx"), prof = read("app/(app)/profile/page.tsx");
  assert.match(today, /const \{ choice: chosenExperience \} = useExperience\(\);/); assert.match(today, /resolveExperience\(chosenExperience, primaryGoal\)/);
  assert.match(today, /basis === "chosen"/); assert.match(today, /Every module is still below/); assert.match(today, /Choose an experience in Profile/);
  assert.doesNotMatch(today, /lensFromGoal/);
  assert.match(prof, /<ExperiencePicker goal=\{state\?\.profile\.primary_goal \?\? null\} \/>/); assert.match(prof, /href="#profile-experience"/);
  assert.ok(prof.indexOf("<ExperiencePicker") < prof.indexOf('<form id="profile-form"'), "outside the profile form: choosing never submits or alters profile data");
  assert.match(picker, /type="radio" name="experience"/); assert.match(picker, /<fieldset className="exp-set" disabled=\{!ready\}>/); assert.match(picker, /<legend className="sr-only">/);
  assert.match(picker, /Automatic/); assert.match(picker, /setChoice\(v === "auto" \? null/);
  assert.match(read("app/globals.css"), /\.exp-opt\{[^}]*min-height:48px/);
});

test("scope: no migration, no profile column, no calculation, auth or data-ownership change", () => {
  const files = ["lib/experience.ts", "lib/useExperience.ts", "components/profile/ExperiencePicker.tsx"].map(read).join("\n");
  assert.doesNotMatch(files, /supabase|\.from\(|\.rpc\(|alter table|fetch\(/i, "browser-local preference only: no network, no database");
  assert.match(read("lib/experience.ts"), /validUid/);
  const lens = read("lib/today/lens.ts");
  assert.match(lens, /biomarkers", "strength"/, "only the order of cards changed in lens.ts");
});
