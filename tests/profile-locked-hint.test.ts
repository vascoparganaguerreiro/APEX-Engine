// Date of birth on the Profile page: when the migration-11 columns are missing the field is disabled. It must LOOK disabled, and say why,
// right below the field, and only then.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMissingProfileColumn } from "../lib/profile.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");
const page = read("app/(app)/profile/page.tsx");
const css = read("app/globals.css");
const HINT = "Not available until profile setup is completed.";
const dobLine = page.split("\n").find((l) => l.includes("Date of birth{age !== null"))!;

test("the hint is rendered only under the locked condition, once, with the agreed wording", () => {
  assert.ok(dobLine, "the Date of birth field is on the page");
  assert.equal(page.split(HINT).length - 1, 1, "the message exists exactly once");
  assert.match(dobLine, /\{locked && <small id="dob-locked" className="field-hint">Not available until profile setup is completed\.<\/small>\}/, "rendered only when locked");
  // not a rendering of the text in any other way (no unconditional copy, no other condition)
  assert.equal((page.match(/dob-locked/g) ?? []).length, 2, "one hint element and one reference to it");
  assert.doesNotMatch(page.replace(dobLine, ""), /profile setup is completed/);
});

test("the hint sits directly below the field, inside its label, and is tied to the input for assistive technology", () => {
  const inputAt = dobLine.indexOf('<input type="date"'), hintAt = dobLine.indexOf("{locked && <small"), labelEnd = dobLine.indexOf("</label>");
  assert.ok(inputAt > 0 && hintAt > inputAt && hintAt < labelEnd, "after the input, before the label closes");
  assert.match(dobLine, /aria-describedby=\{locked \? "dob-locked" : undefined\}/, "described by the hint only when it exists");
});

test("locked and the field's disabled state are the same condition, so the hint matches exactly when the field is inert", () => {
  assert.match(dobLine, /disabled=\{locked\}/);
  assert.match(page, /locked = !state\.migrated/);
  assert.equal((dobLine.match(/\{locked\b/g) ?? []).length, 3, "disabled, aria-describedby and the hint all use the same flag, with no other condition");
  // and `migrated` is false only for a genuinely missing migration-11 column, never for a network or permission error
  assert.equal(isMissingProfileColumn({ code: "42703", message: 'column profiles.birth_date does not exist' }), true);
  assert.equal(isMissingProfileColumn({ code: "PGRST204", message: "Could not find the 'field_sources' column of 'profiles' in the schema cache" }), true);
  assert.equal(isMissingProfileColumn({ code: "42501", message: "permission denied for table profiles" }), false);
  assert.equal(isMissingProfileColumn({ message: "Failed to fetch" }), false);
  assert.equal(isMissingProfileColumn({ code: "42703", message: "column profiles.something_else does not exist" }), false);
});

test("an editable field is untouched: no hint text, no description, same handler and value format", () => {
  assert.match(dobLine, /type="date" value=\{draft\.birth_date\} max=\{today\} onChange=\{text\("birth_date"\)\}/, "the picker and its change handler are unchanged");
  assert.match(read("lib/profile.ts"), /if \(\(existing\.birth_date \?\? ""\) !== d\.birth_date\.trim\(\)\) patch\.birth_date = d\.birth_date\.trim\(\) \|\| null;/, "saving is unchanged");
});

test("CSS: disabled fields look disabled; the hint is small, muted, wraps on phones", () => {
  assert.match(css, /input:disabled,select:disabled,textarea:disabled\{opacity:\.55;cursor:not-allowed\}/);
  assert.match(css, /\.field-hint\{display:block;font-size:12\.5px;line-height:1\.4;color:var\(--muted\)\}/);
  assert.match(css, /label\{display:flex;flex-direction:column;gap:6px;/, "the label stacks its children, so the hint falls below the input at any width");
  const rule = css.match(/\.field-hint\{[^}]*\}/)![0];
  assert.doesNotMatch(rule, /white-space:nowrap|width:|position:|overflow:hidden/, "text wraps instead of being cut off");
  assert.match(css, /font-size:16px\}/, "phone inputs keep their 16px size");
});
