import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOCUMENT_STATUSES, type DocumentRow, type DocumentStatus } from "../web/queries.ts";
import { documentKpis, formatCreated, statusBadge } from "../web/registry.ts";

const row = (status: DocumentStatus): DocumentRow => ({
  id: 1,
  ref: `NDA-2026-${status}`,
  title: "Mutual NDA",
  counterpartyName: "Acme",
  templateName: "Mutual NDA",
  kind: "nda",
  status,
  createdAt: new Date("2026-10-02T09:30:00Z"),
  hasPdf: true,
});

const values = (cards: ReturnType<typeof documentKpis>) => cards.map((c) => `${c.label}=${c.value}`);

describe("documentKpis", () => {
  it("always returns the four cards in order with their copy", () => {
    assert.deepEqual(documentKpis([]), [
      { label: "Total", value: "0", sub: "documents in the registry" },
      { label: "Awaiting signature", value: "0", sub: "sent, not signed yet" },
      { label: "Completed", value: "0", sub: "signed by every party" },
      { label: "Drafts", value: "0", sub: "not sent yet" },
    ]);
  });

  it("counts sent as awaiting, and draft plus generated as drafts", () => {
    const rows = [row("draft"), row("generated"), row("generated"), row("sent"), row("completed"), row("completed"), row("completed")];
    assert.deepEqual(values(documentKpis(rows)), ["Total=7", "Awaiting signature=1", "Completed=3", "Drafts=3"]);
  });

  it("counts declined and expired in the total only", () => {
    assert.deepEqual(values(documentKpis([row("declined"), row("expired"), row("sent")])), ["Total=3", "Awaiting signature=1", "Completed=0", "Drafts=0"]);
  });
});

describe("statusBadge", () => {
  it("falls back to a neutral badge for a status it does not know", () => {
    assert.deepEqual(statusBadge("archived" as DocumentStatus), { label: "Unknown", className: "badge" });
    assert.deepEqual(statusBadge("constructor" as DocumentStatus), { label: "Unknown", className: "badge" });
    assert.deepEqual(statusBadge(undefined as unknown as DocumentStatus), { label: "Unknown", className: "badge" });
  });

  it("labels every status the schema allows", () => {
    for (const status of DOCUMENT_STATUSES) {
      const badge = statusBadge(status);
      assert.match(badge.label, /^[A-Z][a-z ]+$/, status);
    }
  });

  it("maps statuses to the shared badge variants", () => {
    assert.deepEqual(
      DOCUMENT_STATUSES.map((s) => [s, statusBadge(s).className]),
      [
        ["draft", "badge"],
        ["generated", "badge"],
        ["sent", "badge warn"],
        ["completed", "badge ok"],
        ["declined", "badge error"],
        ["expired", "badge error"],
      ],
    );
  });
});

describe("formatCreated", () => {
  it("shows the UTC day and minute", () => {
    assert.equal(formatCreated(new Date("2026-10-02T09:30:45Z")), "2026-10-02 09:30");
  });
});
