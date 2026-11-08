import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completionTime, mapSubmissionStatus, mergeStoredSigners, safeReported } from "../src/signature-status.ts";
import type { SigningLink } from "../src/signature-store.ts";

describe("mapSubmissionStatus", () => {
  it("maps the statuses DocuSeal gives a submission to the document statuses", () => {
    assert.equal(mapSubmissionStatus("pending"), "sent");
    assert.equal(mapSubmissionStatus("completed"), "completed");
    assert.equal(mapSubmissionStatus("declined"), "declined");
    assert.equal(mapSubmissionStatus("expired"), "expired");
  });

  it("maps anything else to null: no change", () => {
    for (const value of ["archived", "Completed", "COMPLETED", " completed", "", "sent", "awaiting", "opened", "__proto__", "constructor"]) assert.equal(mapSubmissionStatus(value), null, value);
  });
});

describe("safeReported", () => {
  it("keeps a plain word and cuts anything that could be markup, a path or too long", () => {
    assert.equal(safeReported("archived"), "archived");
    assert.equal(safeReported("in_review-2"), "in_review-2");
    assert.equal(safeReported("<script>alert(1)</script>"), "scriptalert1script");
    assert.equal(safeReported("x".repeat(100)).length, 40);
    assert.equal(safeReported("../../etc"), "etc");
    assert.equal(safeReported("<>"), "");
  });
});

describe("mergeStoredSigners", () => {
  const links: SigningLink[] = [
    { role: "Acme", name: "Ana", email: "ana@acme.test", link: "https://sign.example.test/s/a" },
    { role: "Beta", name: "Ben", email: "ben@beta.test", link: "https://sign.example.test/s/b" },
  ];

  it("adds each signer's status and time, matched by role, and keeps the link, name and email", () => {
    const merged = mergeStoredSigners(links, [
      { role: "Beta", email: "other@x.test", status: "opened", at: "2026-10-12T09:30:00.000Z" },
      { role: "Acme", email: "ana@acme.test", status: "completed", at: "2026-10-12T10:00:00.000Z" },
    ]);
    assert.deepEqual(merged, {
      changed: true,
      value: [
        { ...links[0], status: "completed", at: "2026-10-12T10:00:00.000Z" },
        { ...links[1], status: "opened", at: "2026-10-12T09:30:00.000Z" },
      ],
    });
  });

  it("matches by email when the role is not found, ignoring case, and ignores a signer it does not know", () => {
    const merged = mergeStoredSigners(links, [
      { role: "Renamed", email: "BEN@beta.test", status: "sent", at: null },
      { role: "Stranger", email: "x@y.test", status: "completed", at: null },
    ]);
    assert.deepEqual(merged.value, [links[0], { ...links[1], status: "sent" }]);
  });

  it("keeps what was stored for a signer DocuSeal did not report, and drops a status that is not a plain word or a time that is not a date-time", () => {
    const stored = [{ ...links[0]!, status: "opened", at: "2026-10-11T00:00:00.000Z" }, links[1]!];
    const merged = mergeStoredSigners(stored, [{ role: "Beta", email: null, status: "<b>x</b>", at: "not a date" }]);
    assert.deepEqual(merged, { changed: false, value: stored });
    assert.deepEqual(mergeStoredSigners(stored, [{ role: "Acme", email: null, status: "completed", at: "tomorrow" }]).value, [{ ...stored[0], status: "completed" }, links[1]]);
  });

  it("stores a time in normalized ISO form, and ignores one that is not an ISO date-time", () => {
    const merged = mergeStoredSigners(links, [{ role: "Acme", email: null, status: "opened", at: "2026-10-12T12:00:00+02:00" }]);
    assert.equal((merged.value as SigningLink[])[0]!.at, "2026-10-12T10:00:00.000Z");
    const odd = mergeStoredSigners(links, [{ role: "Acme", email: null, status: "opened", at: "1" }]);
    assert.equal((odd.value as SigningLink[])[0]!.at, undefined);
  });

  it("never drops a stored entry or a stored key: malformed entries and unknown keys come back as they were, in place", () => {
    const stored = [
      null,
      "text",
      { role: "Acme", name: "Ana", email: "ana@acme.test", link: "javascript:alert(1)", note: "keep me", extra: { deep: [1, 2] } },
      { role: "Beta" },
      7,
      { role: "Gamma", name: "Gus", email: "gus@x.test", link: "https://sign.example.test/s/g", status: 5, at: false },
    ];
    const merged = mergeStoredSigners(stored, [
      { role: "Acme", email: null, status: "completed", at: "2026-10-12T10:00:00.000Z" },
      { role: "Gamma", email: null, status: "opened", at: null },
    ]);
    assert.equal(merged.changed, true);
    assert.deepEqual(merged.value, [
      null,
      "text",
      { role: "Acme", name: "Ana", email: "ana@acme.test", link: "javascript:alert(1)", note: "keep me", extra: { deep: [1, 2] }, status: "completed", at: "2026-10-12T10:00:00.000Z" },
      { role: "Beta" },
      7,
      { role: "Gamma", name: "Gus", email: "gus@x.test", link: "https://sign.example.test/s/g", status: "opened", at: false },
    ]);
    assert.deepEqual(stored[2], { role: "Acme", name: "Ana", email: "ana@acme.test", link: "javascript:alert(1)", note: "keep me", extra: { deep: [1, 2] } }, "the input is not modified");
  });

  it("reports no change when the reported status and time are what is stored, and leaves a value that is not a list alone", () => {
    const stored = [{ ...links[0]!, status: "completed", at: "2026-10-12T10:00:00.000Z" }, links[1]!];
    assert.equal(mergeStoredSigners(stored, [{ role: "Acme", email: null, status: "completed", at: "2026-10-12T10:00:00.000Z" }]).changed, false);
    for (const odd of [null, undefined, "x", 3, {}, { role: "Acme" }]) {
      assert.deepEqual(mergeStoredSigners(odd, [{ role: "Acme", email: null, status: "completed", at: null }]), { changed: false, value: odd });
    }
  });

  it("matches an email only against a stored entry that has a text email", () => {
    const merged = mergeStoredSigners([{ role: "A", email: 5 }, { role: "B" }], [{ role: "Z", email: "a@x.test", status: "sent", at: null }]);
    assert.equal(merged.changed, false);
  });
});

describe("completionTime", () => {
  it("prefers the time DocuSeal gives for the submission, else the latest completed signer", () => {
    assert.equal(completionTime("2026-10-12T11:00:00.000Z", [])?.toISOString(), "2026-10-12T11:00:00.000Z");
    const signers = [
      { role: "A", email: null, status: "completed", at: "2026-10-12T10:00:00.000Z" },
      { role: "B", email: null, status: "completed", at: "2026-10-12T10:30:00.000Z" },
      { role: "C", email: null, status: "opened", at: "2026-10-12T12:00:00.000Z" },
    ];
    assert.equal(completionTime(null, signers)?.toISOString(), "2026-10-12T10:30:00.000Z");
    assert.equal(completionTime(null, [{ role: "A", email: null, status: "opened", at: "2026-10-12T12:00:00.000Z" }]), null);
  });
});
