import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTemplateUpdate, roleNames, templateNameForPdf } from "../src/signature-payload.ts";

describe("templateNameForPdf", () => {
  it("is the file name without its extension, as DocuSeal names an uploaded template and as the skill looks it up", () => {
    assert.equal(templateNameForPdf("NDA-2026-001-beta.pdf"), "NDA-2026-001-beta");
    assert.equal(templateNameForPdf("NDA-2026-001-beta.PDF"), "NDA-2026-001-beta");
    assert.equal(templateNameForPdf("sub/NDA-2026-001-beta.pdf"), "NDA-2026-001-beta");
    assert.equal(templateNameForPdf("a.b.pdf"), "a.b");
  });
});

describe("roleNames", () => {
  it("uses the short name of the owner and the counterparty name", () => {
    assert.deepEqual(roleNames("Acme", "Beta"), { owner: "Acme", counterparty: "Beta" });
  });

  it("tells the roles apart when both names are the same", () => {
    assert.deepEqual(roleNames("Acme", "Acme"), { owner: "Acme", counterparty: "Acme (2)" });
  });

  it("tells the roles apart ignoring case and surrounding space, so each signer gets their own link", () => {
    assert.deepEqual(roleNames("Beta", "beta"), { owner: "Beta", counterparty: "beta (2)" });
    assert.deepEqual(roleNames("  BETA ", "Beta Ltd"), { owner: "BETA", counterparty: "Beta Ltd" });
    assert.deepEqual(roleNames("Beta  Ltd", "beta ltd"), { owner: "Beta Ltd", counterparty: "beta ltd (2)" });
    assert.deepEqual(roleNames(undefined, "owner"), { owner: "Owner", counterparty: "owner (2)" });
  });

  it("keeps both roles within the limit after the de-duplication suffix", () => {
    const long = "x".repeat(300);
    const roles = roleNames(long, long);
    assert.ok(roles.owner.length <= 100 && roles.counterparty.length <= 100, `${roles.owner.length}/${roles.counterparty.length}`);
    assert.notEqual(roles.owner.toLowerCase(), roles.counterparty.toLowerCase());
    const exact = roleNames("y".repeat(100), "Y".repeat(100));
    assert.ok(exact.counterparty.length <= 100 && exact.counterparty.endsWith(" (2)"));
    assert.notEqual(exact.owner.toLowerCase(), exact.counterparty.toLowerCase());
  });

  it("falls back to Owner, collapses spaces and keeps a role short", () => {
    assert.deepEqual(roleNames(undefined, "Beta"), { owner: "Owner", counterparty: "Beta" });
    assert.deepEqual(roleNames("  ", "  Beta   Ltd "), { owner: "Owner", counterparty: "Beta Ltd" });
    assert.equal(roleNames("x".repeat(300), "y").owner.length, 100);
    assert.equal(roleNames("Owner", "").counterparty, "Counterparty");
  });
});

describe("buildTemplateUpdate", () => {
  const fields = [
    { id: "firma-1", page: 2, x: 0.1, y: 0.8, w: 0.3, h: 0.05 },
    { id: "fecha-1", page: 2, x: 0.1, y: 0.86, w: 0.3, h: 0.03 },
    { id: "firma-2", page: 2, x: 0.55, y: 0.8, w: 0.3, h: 0.05 },
    { id: "fecha-2", page: 2, x: 0.55, y: 0.86, w: 0.3, h: 0.03 },
  ];
  const counter = () => {
    let n = 0;
    return () => `new-${++n}`;
  };
  const build = (existing: string[]) => {
    const built = buildTemplateUpdate({ fields, attachmentUuid: "att-1", existingSubmitterUuids: existing, ownerRole: "Acme", counterpartyRole: "Beta", newUuid: counter() });
    assert.ok(built.ok, "expected an update");
    return built.ok ? built.update : (undefined as never);
  };

  it("maps side 1 to the owner and side 2 to the counterparty, with the stored coordinates", () => {
    const update = build(["sub-a", "sub-b"]);
    assert.deepEqual(update.submitters, [
      { name: "Acme", uuid: "sub-a" },
      { name: "Beta", uuid: "sub-b" },
    ]);
    assert.deepEqual(
      update.fields.map((f) => [f.submitter_uuid, f.name, f.type, f.required]),
      [
        ["sub-a", "Firma Acme", "signature", true],
        ["sub-a", "Fecha Acme", "date", true],
        ["sub-b", "Firma Beta", "signature", true],
        ["sub-b", "Fecha Beta", "date", true],
      ],
    );
    assert.deepEqual(update.fields[2]!.areas, [{ x: 0.55, y: 0.8, w: 0.3, h: 0.05, page: 2, attachment_uuid: "att-1" }]);
    assert.deepEqual(update.fields[1]!.areas, [{ x: 0.1, y: 0.86, w: 0.3, h: 0.03, page: 2, attachment_uuid: "att-1" }]);
  });

  it("gives every field its own uuid and makes uuids for submitters the template does not have yet", () => {
    const update = build([]);
    assert.deepEqual(
      update.submitters.map((s) => s.uuid),
      ["new-1", "new-2"],
    );
    assert.equal(new Set(update.fields.map((f) => f.uuid)).size, 4);
    assert.ok(update.fields.every((f) => !["new-1", "new-2"].includes(f.uuid)));
    assert.deepEqual(build(["only-one"]).submitters.map((s) => s.uuid), ["only-one", "new-1"]);
  });

  it("keeps the order of the stored boxes", () => {
    const shuffled = buildTemplateUpdate({ fields: [fields[3]!, fields[0]!, fields[2]!, fields[1]!], attachmentUuid: "a", existingSubmitterUuids: ["x", "y"], ownerRole: "A", counterpartyRole: "B", newUuid: counter() });
    assert.ok(shuffled.ok);
    assert.deepEqual(shuffled.ok && shuffled.update.fields.map((f) => f.name), ["Fecha B", "Firma A", "Firma B", "Fecha A"]);
  });

  it("refuses a box id it does not know with a typed result: never a date field, never a TypeError", () => {
    for (const id of ["firma-3", "fecha-0", "foo-1", "firma", "firma-1-2", "", "__proto__-1", "constructor-2", "toString-1", "FIRMA-1"]) {
      const bad = { id, page: 2, x: 0.1, y: 0.8, w: 0.3, h: 0.05 };
      let built: ReturnType<typeof buildTemplateUpdate> | undefined;
      assert.doesNotThrow(() => {
        built = buildTemplateUpdate({ fields: [bad, ...fields.slice(1)], attachmentUuid: "a", existingSubmitterUuids: ["x", "y"], ownerRole: "A", counterpartyRole: "B", newUuid: counter() });
      }, id);
      assert.equal(built?.ok, false, id);
      assert.match(built && !built.ok ? built.reason : "", /box/i, id);
    }
  });
});
