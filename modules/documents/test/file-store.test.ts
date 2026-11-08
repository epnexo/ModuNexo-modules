import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { documentsDir, ensureDir, findRepoRoot, pdfFileName, resolveInside, slugify } from "../src/file-store.ts";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "documents-files-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A fake checkout: a package.json with workspaces at its root. Each test that needs one makes its own. */
async function makeRepo(name: string): Promise<string> {
  const root = join(dir, name);
  await mkdir(join(root, "modules"), { recursive: true });
  await mkdir(join(root, "apps", "web"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["modules/*"] }));
  return root;
}

describe("file names", () => {
  it("makes a lower-case ascii slug of at most 40 characters", () => {
    assert.equal(slugify("Beta Ltd."), "beta-ltd");
    assert.equal(slugify("Ñandú & Compañía, S.A."), "nandu-compania-s-a");
    assert.equal(slugify("a".repeat(60)), "a".repeat(40));
    assert.equal(slugify("  --x--  "), "x");
  });

  it("falls back to a fixed word when nothing usable is left", () => {
    for (const text of ["", "!!!", "日本語", "../.."]) assert.equal(slugify(text), "counterparty", text);
  });

  it("names the file REF-slug.pdf, never with a path", () => {
    assert.equal(pdfFileName("NDA-2026-001", "Beta Ltd"), "NDA-2026-001-beta-ltd.pdf");
    assert.equal(pdfFileName("NDA-2026-002", "../../etc/passwd"), "NDA-2026-002-etc-passwd.pdf");
  });
});

describe("where documents live", () => {
  it("finds the repository root from a folder inside it", async () => {
    const root = await makeRepo("repo-find");
    assert.equal(findRepoRoot(join(root, "apps", "web")), root);
    assert.equal(findRepoRoot(root), root);
  });

  it("falls back to the folder it was given outside a repository, so a default documents folder would be <that folder>/var/documents", async () => {
    const outside = join(dir, "not-a-checkout", "deep");
    await mkdir(outside, { recursive: true });
    await writeFile(join(dir, "not-a-checkout", "package.json"), JSON.stringify({ name: "no workspaces here" }));
    assert.equal(findRepoRoot(outside), outside, "a package.json without workspaces does not count");
    assert.equal(documentsDir({}, outside), join(outside, "var", "documents"));
    assert.equal(documentsDir({ DOCUMENTS_DIR: "/srv/pdfs" }, outside), "/srv/pdfs", "an absolute setting does not depend on the working directory");
  });

  it("defaults to var/documents at the repository root, and resolves a relative setting against it", async () => {
    const root = await makeRepo("repo-documents");
    assert.equal(documentsDir({}, join(root, "apps", "web")), join(root, "var", "documents"));
    assert.equal(documentsDir({ DOCUMENTS_DIR: "  " }, root), join(root, "var", "documents"));
    assert.equal(documentsDir({ DOCUMENTS_DIR: "data/pdfs" }, join(root, "apps", "web")), join(root, "data", "pdfs"));
    assert.equal(documentsDir({ DOCUMENTS_DIR: "/srv/pdfs" }, root), "/srv/pdfs");
  });

  it("creates the folder on demand, readable by its owner only", async () => {
    const target = join(dir, "made", "documents");
    await ensureDir(target);
    assert.equal((await stat(target)).mode & 0o777, 0o700);
    await ensureDir(target);
  });
});

describe("resolveInside", () => {
  it("returns the path of a file below the folder", () => {
    assert.equal(resolveInside("/srv/docs", "NDA-2026-001-x.pdf"), "/srv/docs/NDA-2026-001-x.pdf");
    assert.equal(resolveInside("/srv/docs", "sub/a.pdf"), "/srv/docs/sub/a.pdf");
  });

  it("refuses anything that leaves the folder, however it is written", () => {
    for (const bad of ["../x.pdf", "a/../../x.pdf", "/etc/passwd", "..", ".", "", "a\u0000.pdf", "/srv/docs-other/x.pdf", "../docs-other/x.pdf"]) {
      assert.equal(resolveInside("/srv/docs", bad), null, JSON.stringify(bad));
    }
    assert.equal(resolveInside("/srv/docs", undefined as unknown as string), null);
  });

  it("refuses a symbolic link that points out of the folder", async () => {
    const folder = join(dir, "linked");
    await mkdir(folder, { recursive: true });
    await writeFile(join(dir, "outside.pdf"), "x");
    await symlink(join(dir, "outside.pdf"), join(folder, "link.pdf"));
    await writeFile(join(folder, "real.pdf"), "x");
    assert.equal(resolveInside(folder, "link.pdf", { followLinks: true }), null);
    assert.equal(resolveInside(folder, "real.pdf", { followLinks: true }), join(folder, "real.pdf"));
  });

  it("treats a dangling symbolic link as outside the folder, whatever it points at, and a file that does not exist as inside", async () => {
    const folder = join(dir, "dangling");
    await mkdir(folder, { recursive: true });
    await symlink(join(dir, "nowhere", "secret.pdf"), join(folder, "to-outside.pdf"));
    await symlink(join(folder, "not-yet.pdf"), join(folder, "to-inside.pdf"));
    await symlink("loop-b.pdf", join(folder, "loop-a.pdf"));
    await symlink("loop-a.pdf", join(folder, "loop-b.pdf"));
    for (const name of ["to-outside.pdf", "to-inside.pdf", "loop-a.pdf"]) assert.equal(resolveInside(folder, name, { followLinks: true }), null, name);
    assert.equal(resolveInside(folder, "missing.pdf", { followLinks: true }), join(folder, "missing.pdf"), "the caller answers not found for it");
  });
});
