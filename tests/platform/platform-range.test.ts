import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SDK_VERSION } from "@modunexo/sdk";

const MODULES_DIR = fileURLToPath(new URL("../../modules/", import.meta.url));
const ids = readdirSync(MODULES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const parts = (version: string): number[] => version.split(".").map(Number);

/** `^X.Y.Z` accepts the SDK when it is the same major (and the same minor below 1.0) and not older than X.Y.Z. */
function caretAccepts(range: string, sdk: string): boolean {
  const [major, minor, patch] = parts(range.slice(1));
  const [sMajor, sMinor, sPatch] = parts(sdk);
  if (major !== sMajor) return false;
  if (major === 0 && minor !== sMinor) return false;
  return minor! < sMinor! || (minor === sMinor && patch! <= sPatch!);
}

describe("a module's platform range", () => {
  it("finds the modules to check", () => {
    assert.ok(ids.length >= 6, `expected the repository's modules, found ${ids.join(", ")}`);
  });

  for (const id of ids) {
    it(`${id}: is a literal range, so a package packed on another machine still matches its manifest.ts`, () => {
      const source = readFileSync(`${MODULES_DIR}${id}/manifest.ts`, "utf8");
      // `apply` evaluates manifest.ts again on the platform and compares it with the manifest.json that was reviewed.
      // A range built from SDK_VERSION differs the moment the two SDKs differ, and the install is refused.
      assert.equal(source.includes("SDK_VERSION"), false, `${id}/manifest.ts must not build platform from SDK_VERSION: write the range as a string`);
    });

    it(`${id}: is a caret range that the SDK of this checkout satisfies`, async () => {
      const { default: manifest } = (await import(`${MODULES_DIR}${id}/manifest.ts`)) as { default: { platform: string } };
      assert.match(manifest.platform, /^\^\d+\.\d+\.\d+$/, `${id}: platform must look like ^0.1.3`);
      assert.equal(caretAccepts(manifest.platform, SDK_VERSION), true, `${id}: platform ${manifest.platform} does not accept SDK ${SDK_VERSION}`);
    });
  }
});
