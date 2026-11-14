import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isMissingObject, parseReportPath, removableUploads, reportPath, uploadOutcome, REPORT_EXT } from "../lib/health/report.ts";

const UID = "0b9f6c1e-4a2d-4c7e-9f00-1234567890ab";
const OTHER = "11111111-2222-4333-8444-555555555555";
const SHA = createHash("sha256").update("lab report").digest("hex");

test("report paths are built from the user id, the content hash and the type", () => {
  assert.equal(reportPath(UID, SHA, "application/pdf"), `${UID}/${SHA}.pdf`);
  assert.equal(reportPath(UID, SHA, "image/jpeg"), `${UID}/${SHA}.jpg`);
  assert.equal(reportPath(UID, SHA, "image/png"), `${UID}/${SHA}.png`);
  assert.equal(reportPath(UID, SHA, "image/webp"), `${UID}/${SHA}.webp`);
  assert.equal(reportPath(UID, SHA, "image/gif"), null);
  assert.equal(reportPath(UID, SHA, "toString"), null, "no prototype keys");
  assert.equal(reportPath(UID, SHA.slice(1), "application/pdf"), null);
  assert.equal(reportPath(UID, SHA.toUpperCase(), "application/pdf"), null);
  assert.equal(reportPath("../x", SHA, "application/pdf"), null);
  assert.equal(reportPath("", SHA, "application/pdf"), null);
});

test("every built path is accepted by the server-side validation", () => {
  for (const mime of Object.keys(REPORT_EXT)) {
    const p = reportPath(UID, SHA, mime)!;
    assert.deepEqual(parseReportPath(p, UID), { sha256: SHA, ext: REPORT_EXT[mime] });
  }
});

test("the server accepts only the caller's own folder and the exact shape", () => {
  const ok = `${UID}/${SHA}.pdf`;
  assert.ok(parseReportPath(ok, UID));
  assert.equal(parseReportPath(ok, OTHER), null, "another user's folder");
  assert.equal(parseReportPath(`${OTHER}/${SHA}.pdf`, UID), null);
  const bad = [
    `/${ok}`, `${ok}/`, ` ${ok}`, `${ok} `, `${ok}\n`, `${UID}//${SHA}.pdf`, `${UID}/../${UID}/${SHA}.pdf`,
    `${UID}/x/${SHA}.pdf`, `${UID}/${SHA}.PDF`, `${UID}/${SHA}.jpeg`, `${UID}/${SHA}.gif`, `${UID}/${SHA}`, `${UID}/${SHA}.pdf.pdf`,
    `${UID}/${SHA.toUpperCase()}.pdf`, `${UID}/${SHA.slice(2)}.pdf`, `${UID}/${SHA}00.pdf`, `${UID.toUpperCase()}/${SHA}.pdf`,
    `${UID}\\${SHA}.pdf`, `${UID}/${SHA}%2epdf`, `lab-reports/${UID}/${SHA}.pdf`, "", `${UID}/`,
  ];
  for (const p of bad) assert.equal(parseReportPath(p, UID), null, JSON.stringify(p));
  for (const p of [null, undefined, 42, { path: ok }, [ok]]) assert.equal(parseReportPath(p, UID), null);
  assert.equal(parseReportPath(ok, ""), null, "no verified user, no path");
});

test("upload outcomes: 'already exists' is not an upload of ours", () => {
  assert.equal(uploadOutcome(null), "created");
  assert.equal(uploadOutcome(undefined), "created");
  assert.equal(uploadOutcome({ message: "The resource already exists", statusCode: "409" }), "existed");
  assert.equal(uploadOutcome({ message: "Duplicate" }), "existed");
  assert.equal(uploadOutcome({ message: "conflict", statusCode: 409 }), "existed");
  assert.equal(uploadOutcome({ message: "new row violates row-level security policy", statusCode: "403" }), "failed");
  assert.equal(uploadOutcome({ message: "The object exceeded the maximum allowed size", statusCode: "413" }), "failed");
});

test("missing storage objects are recognised", () => {
  assert.equal(isMissingObject({ message: "Object not found", statusCode: "404", status: 400 }), true);
  assert.equal(isMissingObject({ message: "x", status: 404 }), true);
  assert.equal(isMissingObject({ message: "x", code: "NoSuchKey" }), true);
  assert.equal(isMissingObject({ message: "Internal error", status: 500 }), false);
  assert.equal(isMissingObject(null), false);
});

test("cleanup removes only objects this page created that nothing needs", () => {
  const a = `${UID}/${"a".repeat(64)}.pdf`, b = `${UID}/${"b".repeat(64)}.png`, c = `${UID}/${"c".repeat(64)}.jpg`;
  // Picked a different file: the old upload goes, the newly selected one stays.
  assert.deepEqual(removableUploads([a, b], [b], []), [a]);
  // Duplicate report / failed save: nothing kept.
  assert.deepEqual(removableUploads([a], [], []), [a]);
  // A path a saved blood test references is never removed.
  assert.deepEqual(removableUploads([a, b], [], [a]), [b]);
  assert.deepEqual(removableUploads([a, b], [], [a, null, b]), []);
  // An object that existed before this page uploaded it is never in `created`, so it can never be returned.
  assert.deepEqual(removableUploads([], [], []), []);
  assert.ok(!removableUploads([a], [null, undefined], []).includes(c));
  // If the reference check failed, nothing is removed.
  assert.deepEqual(removableUploads([a, b], [], null), []);
  // Duplicates collapse.
  assert.deepEqual(removableUploads(new Set([a, a]), [null], []), [a]);
  assert.deepEqual(removableUploads([a, a], [], []), [a]);
});
