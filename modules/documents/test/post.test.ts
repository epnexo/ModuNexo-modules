import assert from "node:assert/strict";
import { describe, it } from "node:test";
import documents from "../manifest.ts";
import { MAX_BODY_BYTES, answer, handleForm, readFields, sameOrigin } from "../web/post.ts";
import { postAction, safeTarget } from "../web/post-action.ts";

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
};
const post = (headers: Record<string, string>, body: BodyInit | null = form({ a: "1" })) => new Request("http://docs.test/documents/x", { method: "POST", headers, body });
const SAME = { origin: "http://docs.test", host: "docs.test" };

describe("sameOrigin", () => {
  it("accepts only an origin whose host is the request host", () => {
    assert.equal(sameOrigin(new Headers(SAME)), true);
    assert.equal(sameOrigin(new Headers({ origin: "http://evil.test", host: "docs.test" })), false);
    assert.equal(sameOrigin(new Headers({ host: "docs.test" })), false, "no origin header");
    assert.equal(sameOrigin(new Headers({ origin: "not a url", host: "docs.test" })), false);
    assert.equal(sameOrigin(new Headers({ origin: "http://docs.test", "x-forwarded-host": "docs.test" })), false, "forwarding headers are not consulted");
  });
});

describe("readFields", () => {
  it("refuses a request from another site with 403, before reading anything", async () => {
    const refused = await readFields(post({ origin: "http://evil.test", host: "docs.test" }));
    assert.ok(refused instanceof Response);
    assert.equal(refused.status, 403);
  });

  it("refuses a body over the limit with 413 and a body that is not a form with 400", async () => {
    const big = await readFields(post({ ...SAME, "content-length": String(MAX_BODY_BYTES + 1) }));
    assert.ok(big instanceof Response && big.status === 413);
    const notForm = await readFields(post({ ...SAME, "content-type": "multipart/form-data; boundary=x" }, "garbage"));
    assert.ok(notForm instanceof Response && notForm.status === 400);
  });

  it("returns the text fields and leaves files out", async () => {
    const body = form({ name: "Acme" });
    body.set("file", new Blob(["x"]), "x.txt");
    assert.deepEqual(await readFields(post(SAME, body)), { name: "Acme" });
  });
});

describe("answer and handleForm", () => {
  it("answers with the state, or with where to go", async () => {
    assert.deepEqual(await answer({ state: { message: "hi" } }).json(), { state: { message: "hi" } });
    assert.deepEqual(await answer({ redirectTo: "/documents/3" }).json(), { redirectTo: "/documents/3" });
    assert.deepEqual(await answer({ state: {} }, { reload: true }).json(), { state: {}, reload: true });
  });

  it("turns an unexpected failure into a 500 that does not repeat the error", async (t) => {
    t.mock.method(console, "error", () => {});
    const response = await handleForm(post(SAME), async () => {
      throw new Error("connect failed postgres://u:hunter2@db.internal/x");
    });
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /hunter2|db\.internal/);
  });
});

describe("every POST route of the module", () => {
  const routes = (documents.pages ?? []).filter((page) => page.kind === "route" && page.methods?.includes("POST"));

  it("is guarded by a permission, and the ones that send need documents.send", () => {
    assert.ok(routes.length >= 8);
    for (const route of routes) assert.ok(route.permission, `${route.path} has no permission`);
    for (const path of ["/documents/send", "/documents/send/clear"]) assert.equal(routes.find((r) => r.path === path)?.permission, "documents.send");
  });

  it("refuses a request from another site before touching any data", async () => {
    for (const route of routes) {
      const handler = (await import(new URL(`../${route.entry}`, import.meta.url).href)) as { POST: (request: Request) => Promise<Response> };
      const response = await handler.POST(post({ origin: "http://evil.test", host: "docs.test" }));
      assert.equal(response.status, 403, route.path);
    }
  });
});

describe("safeTarget", () => {
  it("lets only a path on this site through", () => {
    assert.equal(safeTarget("/documents/3?sent=1"), "/documents/3?sent=1");
    for (const bad of ["//evil.test", "https://evil.test", "/\\evil.test", "javascript:alert(1)", "", 7, null, undefined]) assert.equal(safeTarget(bad), null, String(bad));
  });
});

describe("postAction", () => {
  const withFetch = (t: { mock: { method: (o: object, n: string, f: unknown) => unknown } }, reply: () => Promise<Response>, calls: { assign: string[]; reloads: number }) => {
    const g = globalThis as Record<string, unknown>;
    g.window = { location: { assign: (to: string) => calls.assign.push(to), reload: () => (calls.reloads += 1) } };
    t.mock.method(globalThis, "fetch", reply);
  };
  const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("returns the state the route answers", async (t) => {
    withFetch(t, reply({ state: { values: { a: "1" }, errors: { a: "bad" } } }), { assign: [], reloads: 0 });
    assert.deepEqual(await postAction("/documents/x")({ values: {}, errors: {} }, form({ a: "1" })), { values: { a: "1" }, errors: { a: "bad" } });
  });

  it("goes where the route says, only on this site", async (t) => {
    const calls = { assign: [] as string[], reloads: 0 };
    withFetch(t, reply({ redirectTo: "/documents/9" }), calls);
    await postAction("/documents/x")({}, form({}));
    assert.deepEqual(calls.assign, ["/documents/9"]);
    const evil = { assign: [] as string[], reloads: 0 };
    withFetch(t, reply({ redirectTo: "//evil.test" }), evil);
    await postAction("/documents/x")({}, form({}));
    assert.deepEqual(evil.assign, [], "an address off this site is never followed");
  });

  it("says so when the session cannot do it, when the route fails and when the server cannot be reached", async (t) => {
    const calls = { assign: [] as string[], reloads: 0 };
    withFetch(t, reply({ error: "no" }, 403), calls);
    assert.match(((await postAction<{ message?: string }>("/documents/x")({}, form({}))).message ?? ""), /permission/);
    withFetch(t, reply({ error: "The form is too large." }, 413), calls);
    assert.equal((await postAction<{ message?: string }>("/documents/x")({}, form({}))).message, "The form is too large.");
    withFetch(t, async () => Promise.reject(new TypeError("fetch failed")), calls);
    assert.match(((await postAction<{ message?: string }>("/documents/x")({}, form({}))).message ?? ""), /could not be reached/);
  });

  it("reloads the page when the route asks for it", async (t) => {
    const calls = { assign: [] as string[], reloads: 0 };
    withFetch(t, reply({ state: {}, reload: true }), calls);
    await postAction("/documents/x")({}, form({}));
    assert.equal(calls.reloads, 1);
  });
});
