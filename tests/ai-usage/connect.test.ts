import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanAddress, sendCommand } from "../../modules/ai-usage/lib/connect.ts";

describe("connect settings", () => {
  it("keeps only the origin of a web address an administrator typed", () => {
    assert.equal(cleanAddress(" https://modunexo.example.com/settings#modules "), "https://modunexo.example.com");
    assert.equal(cleanAddress("http://127.0.0.1:3000/x"), "http://127.0.0.1:3000");
  });

  it("refuses an empty value, a value that is not a web address and a value that is not text", () => {
    assert.equal(cleanAddress(""), null);
    assert.equal(cleanAddress("javascript:alert(1)"), null);
    assert.equal(cleanAddress("modunexo.example.com"), null);
    assert.equal(cleanAddress(null), null);
    assert.equal(cleanAddress(42), null);
  });

  it("builds the send command with the address and never a real token", () => {
    assert.equal(
      sendCommand("https://modunexo.example.com"),
      "# Once: save the address (https://modunexo.example.com) and a token on this computer\nnode --import tsx src/cli/ingest.ts --setup\n# Then, whenever you want to send what changed\nnode --import tsx src/cli/ingest.ts",
    );
  });
});
