import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { defaultConfigPath, loadConfig, looksLikeToken, resolveSending, saveConfig } from "../../modules/ai-usage/src/cli/config.ts";
import { runSetup, type Prompter } from "../../modules/ai-usage/src/cli/setup.ts";

const TOKEN = "mdnx_910abf61_K46j1NvK0lS9ULEXpNy6KqE506oT2i37cVEWrk6VmtQ";
let work = "";
let caFile = "";

before(() => {
  work = mkdtempSync(join(tmpdir(), "au-setup-"));
  caFile = join(work, "ca.pem");
  // A real self-signed certificate, so the check that a file holds a certificate sees real bytes.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(work, "k.pem"), "-out", caFile, "-days", "2", "-subj", "/CN=test-ca"], { stdio: "ignore" });
});
after(() => rmSync(work, { recursive: true, force: true }));

/** Answers the questions in order and records what was asked, so a test can check nothing secret was echoed. */
function scripted(answers: string[], secrets: string[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? "";
    },
    askSecret: async (question) => {
      asked.push(question);
      return secrets.shift() ?? "";
    },
  };
}

describe("saved config", () => {
  it("lives under ~/.config/ai-usage by default", () => {
    assert.equal(defaultConfigPath("/home/x"), "/home/x/.config/ai-usage/config.json");
  });

  it("is empty when there is no file", () => {
    assert.deepEqual(loadConfig(join(work, "missing.json")), {});
  });

  it("is written readable by its owner only, in a private folder, and read back", () => {
    const file = join(work, "private", "config.json");
    saveConfig(file, { url: "https://p.test", token: TOKEN });
    assert.deepEqual(loadConfig(file), { url: "https://p.test", token: TOKEN });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(work, "private")).mode & 0o777, 0o700);
  });

  it("refuses a file that is not valid JSON, without printing its content", () => {
    const file = join(work, "broken.json");
    writeFileSync(file, `{"token": "${TOKEN}"`);
    assert.throws(() => loadConfig(file), (error: Error) => /not valid JSON/.test(error.message) && !error.message.includes(TOKEN));
  });

  it("recognizes the shape of a service token", () => {
    assert.equal(looksLikeToken(TOKEN), true);
    for (const bad of ["", "mdnx_...", "secret", "mdnx_910abf61_short"]) assert.equal(looksLikeToken(bad), false);
  });
});

describe("runSetup", () => {
  it("asks for the address, the token and the certificate, and saves them", async () => {
    const file = join(work, "setup-1.json");
    const prompter = scripted(["https://modunexo.home.arpa/svc/ai-usage/ingest", caFile], [TOKEN]);
    const saved = await runSetup({ path: file, prompter, current: {}, log: () => {} });
    assert.deepEqual(saved, { url: "https://modunexo.home.arpa", token: TOKEN, caFile });
    assert.deepEqual(loadConfig(file), saved);
  });

  it("never prints the token", async () => {
    const lines: string[] = [];
    const prompter = scripted(["https://p.test", ""], [TOKEN]);
    await runSetup({ path: join(work, "setup-2.json"), prompter, current: {}, log: (line) => lines.push(line) });
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => !line.includes(TOKEN) && !line.includes("K46j1NvK")));
    assert.ok(prompter.asked.every((question) => !question.includes(TOKEN)));
  });

  it("keeps the saved token and certificate when the answers are left empty", async () => {
    const file = join(work, "setup-3.json");
    const current = { url: "https://old.test", token: TOKEN, caFile };
    const saved = await runSetup({ path: file, prompter: scripted(["", ""], [""]), current, log: () => {} });
    assert.deepEqual(saved, current);
  });

  it("asks again when the address is not a web address", async () => {
    const prompter = scripted(["not an address", "https://p.test", ""], [TOKEN]);
    const saved = await runSetup({ path: join(work, "setup-4.json"), prompter, current: {}, log: () => {} });
    assert.equal(saved.url, "https://p.test");
  });

  it("asks again when the token does not look like one, and gives up after three tries", async () => {
    const ok = await runSetup({ path: join(work, "setup-5.json"), prompter: scripted(["https://p.test", ""], ["mdnx_...", TOKEN]), current: {}, log: () => {} });
    assert.equal(ok.token, TOKEN);
    const file = join(work, "setup-6.json");
    await assert.rejects(runSetup({ path: file, prompter: scripted(["https://p.test", ""], ["a", "b", "c"]), current: {}, log: () => {} }), /token/i);
    assert.deepEqual(loadConfig(file), {});
  });

  it("refuses a certificate file that is missing or is not a certificate", async () => {
    const notCert = join(work, "notes.txt");
    writeFileSync(notCert, "hello");
    const prompter = scripted(["https://p.test", join(work, "nope.pem"), notCert, caFile], [TOKEN]);
    const saved = await runSetup({ path: join(work, "setup-7.json"), prompter, current: {}, log: () => {} });
    assert.equal(saved.caFile, caFile);
  });

  it("writes nothing until every answer is valid", async () => {
    const file = join(work, "setup-8.json");
    await assert.rejects(runSetup({ path: file, prompter: scripted(["x", "y", "z"], []), current: {}, log: () => {} }));
    assert.throws(() => readFileSync(file));
  });
});

describe("resolveSending", () => {
  const saved = { url: "https://saved.test", token: "saved-token", caFile: "/ca.pem" };

  it("uses the saved values when nothing else is given", () => {
    assert.deepEqual(resolveSending({ url: undefined }, {}, saved), { url: "https://saved.test", token: "saved-token", caFile: "/ca.pem" });
  });

  it("lets the flag and the environment win over the saved values", () => {
    assert.deepEqual(resolveSending({ url: "https://flag.test" }, { AI_USAGE_TOKEN: "env-token" }, saved), { url: "https://flag.test", token: "env-token", caFile: "/ca.pem" });
  });

  it("does not add a certificate when the environment already names one", () => {
    assert.equal(resolveSending({ url: undefined }, { NODE_EXTRA_CA_CERTS: "/other.pem" }, saved).caFile, undefined);
  });

  it("is not sending when there is no address anywhere", () => {
    assert.equal(resolveSending({ url: undefined }, {}, {}).url, undefined);
  });
});
