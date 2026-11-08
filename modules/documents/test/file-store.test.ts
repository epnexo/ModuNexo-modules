import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ensureDir, findRepoRoot, pdfFileName, scratchDir, slugify } from "../src/file-store.ts";

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

describe("the folders the module uses", () => {
  it("finds the repository root from a folder inside it", async () => {
    const root = await makeRepo("repo-find");
    assert.equal(findRepoRoot(join(root, "apps", "web")), root);
    assert.equal(findRepoRoot(root), root);
  });

  it("falls back to the folder it was given outside a repository", async () => {
    const outside = join(dir, "not-a-checkout", "deep");
    await mkdir(outside, { recursive: true });
    await writeFile(join(dir, "not-a-checkout", "package.json"), JSON.stringify({ name: "no workspaces here" }));
    assert.equal(findRepoRoot(outside), outside, "a package.json without workspaces does not count");
  });

  it("renders into a scratch folder under the system temp folder, never inside the repository", () => {
    assert.equal(scratchDir(), join(tmpdir(), "modunexo-documents"));
  });

  it("creates the folder on demand, readable by its owner only", async () => {
    const target = join(dir, "made", "documents");
    await ensureDir(target);
    assert.equal((await stat(target)).mode & 0o777, 0o700);
    await ensureDir(target);
  });
});

