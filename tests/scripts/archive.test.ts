import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/archive-old.sh", import.meta.url));
let root: string;
let dist: string;
let versions: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "archive-"));
  dist = join(root, "dist");
  versions = join(root, "versions");
  mkdirSync(dist);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (name: string, text = name) => writeFileSync(join(dist, name), text);
const run = (id: string, current: string) => spawnSync("bash", [SCRIPT, id, current], { env: { ...process.env, DIST_DIR: dist, VERSIONS_DIR: versions }, encoding: "utf8" });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("scripts/archive-old.sh", () => {
  it("moves every older version of the module out of dist, keeps the current one, and writes the SHA-256 of each next to it", () => {
    put("inbox-0.1.0.tgz", "one");
    put("inbox-0.2.0.tgz", "two");
    put("inbox-0.3.0.tgz", "three");
    const done = run("inbox", "0.3.0");
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(readdirSync(dist), ["inbox-0.3.0.tgz"]);
    assert.equal(readFileSync(join(versions, "inbox", "0.1.0", "inbox-0.1.0.tgz"), "utf8"), "one");
    assert.equal(readFileSync(join(versions, "inbox", "0.2.0", "inbox-0.2.0.tgz"), "utf8"), "two");
    assert.equal(readFileSync(join(versions, "inbox", "0.1.0", "SHA256"), "utf8"), `${sha("one")}  inbox-0.1.0.tgz\n`);
    assert.equal(readFileSync(join(versions, "inbox", "0.2.0", "SHA256"), "utf8"), `${sha("two")}  inbox-0.2.0.tgz\n`);
    assert.match(done.stdout, /archived inbox 0\.1\.0/);
  });

  it("does nothing when the current version is the only one", () => {
    put("agenda-0.1.0.tgz");
    const done = run("agenda", "0.1.0");
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(readdirSync(dist), ["agenda-0.1.0.tgz"]);
    assert.equal(existsSync(versions), false);
  });

  it("leaves other modules and files that are not <id>-<version>.tgz alone, also a module whose id starts with the same words", () => {
    put("inbox-0.1.0.tgz");
    put("contacts-0.1.0.tgz");
    put("inbox-pro-0.1.0.tgz");
    put("inbox-notes.txt");
    put("inbox-latest.tgz");
    const done = run("inbox", "0.2.0");
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(readdirSync(dist).sort(), ["contacts-0.1.0.tgz", "inbox-latest.tgz", "inbox-notes.txt", "inbox-pro-0.1.0.tgz"]);
    assert.deepEqual(readdirSync(join(versions, "inbox")), ["0.1.0"]);
  });

  it("takes a prerelease version for a version", () => {
    put("inbox-1.0.0-rc.1.tgz", "rc");
    assert.equal(run("inbox", "1.0.0").status, 0);
    assert.equal(readFileSync(join(versions, "inbox", "1.0.0-rc.1", "inbox-1.0.0-rc.1.tgz"), "utf8"), "rc");
  });

  it("drops the copy in dist when the same bytes were archived already", () => {
    put("inbox-0.1.0.tgz", "same");
    assert.equal(run("inbox", "0.2.0").status, 0);
    put("inbox-0.1.0.tgz", "same");
    const again = run("inbox", "0.2.0");
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(readdirSync(dist), []);
  });

  it("refuses to overwrite an archived version with different bytes, and leaves dist untouched", () => {
    put("inbox-0.1.0.tgz", "original");
    assert.equal(run("inbox", "0.2.0").status, 0);
    put("inbox-0.1.0.tgz", "rebuilt differently");
    const refused = run("inbox", "0.2.0");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /different/);
    assert.deepEqual(readdirSync(dist), ["inbox-0.1.0.tgz"]);
    assert.equal(readFileSync(join(versions, "inbox", "0.1.0", "inbox-0.1.0.tgz"), "utf8"), "original");
  });

  it("asks for the module and the current version", () => {
    assert.notEqual(spawnSync("bash", [SCRIPT], { env: { ...process.env, DIST_DIR: dist, VERSIONS_DIR: versions }, encoding: "utf8" }).status, 0);
    assert.notEqual(run("inbox", "").status, 0);
  });
});
