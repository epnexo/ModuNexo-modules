import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { type DocusealClient, type DocusealError, type DocusealResult, MAX_TIMEOUT_MS, createDocusealClient, docusealFromEnv } from "../src/docuseal-client.ts";

/** Every answer below has the shape the /nda skill's code reads. Nothing here touches the network. */

const BASE = "https://sign.example.test";
const TOKEN = "tok_SECRET_123";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | null | undefined;
}

type Answer = Response | ((call: Call, init: RequestInit) => Response | Promise<Response>);

/** A fetch that answers from a queue and records each call; a call beyond the queue fails loudly. */
function fake(...answers: Answer[]) {
  const calls: Call[] = [];
  const queue = [...answers];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: Call = {
      url: String(input),
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
      redirect: init.redirect,
      signal: init.signal,
    };
    calls.push(call);
    const next = queue.shift();
    if (next === undefined) throw new Error("no answer queued");
    return typeof next === "function" ? next(call, init) : next;
  }) as typeof fetch;
  return { calls, impl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const client = (impl: typeof fetch, extra: { timeoutMs?: number } = {}): DocusealClient => createDocusealClient({ url: BASE, token: TOKEN, fetch: impl, ...extra });

function failure<T>(result: DocusealResult<T>): DocusealError {
  assert.equal(result.ok, false, "expected a failure");
  return result.ok ? ({ kind: "unexpected", what: "ok" } as DocusealError) : result.error;
}
function success<T>(result: DocusealResult<T>): T {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`);
  return (result as { ok: true; value: T }).value;
}

describe("docusealFromEnv", () => {
  it("is not configured when the URL or the token is missing or blank", () => {
    for (const env of [{}, { DOCUSEAL_URL: BASE }, { DOCUSEAL_API_TOKEN: TOKEN }, { DOCUSEAL_URL: "  ", DOCUSEAL_API_TOKEN: TOKEN }, { DOCUSEAL_URL: BASE, DOCUSEAL_API_TOKEN: " " }]) {
      assert.deepEqual(failure(docusealFromEnv(env)), { kind: "not-configured" }, JSON.stringify(env));
    }
  });

  it("is not configured for a URL that is not plain http or https, or that carries credentials", () => {
    for (const url of ["ftp://sign.example.test", "javascript:alert(1)", "not a url", "https://user:pw@sign.example.test", "sign.example.test"]) {
      assert.deepEqual(failure(docusealFromEnv({ DOCUSEAL_URL: url, DOCUSEAL_API_TOKEN: TOKEN })), { kind: "not-configured" }, url);
    }
  });

  it("is not configured for a URL with a query string or a fragment, however it is spelled", () => {
    for (const url of [`${BASE}/?a=1`, `${BASE}?`, `${BASE}/#top`, `${BASE}#`, `${BASE}/docuseal?x`]) {
      assert.deepEqual(failure(docusealFromEnv({ DOCUSEAL_URL: url, DOCUSEAL_API_TOKEN: TOKEN })), { kind: "not-configured" }, url);
    }
  });

  it("builds a client, with the trailing slash of the URL dropped", async () => {
    const { calls, impl } = fake(json({ data: [] }));
    const built = success(docusealFromEnv({ DOCUSEAL_URL: `${BASE}/`, DOCUSEAL_API_TOKEN: ` ${TOKEN} ` }, { fetch: impl }));
    await built.findTemplateByName("x");
    assert.equal(calls[0]!.url.startsWith(`${BASE}/api/templates?`), true);
    assert.equal(calls[0]!.headers["x-auth-token"], TOKEN);
  });
});

describe("createDocusealClient", () => {
  it("never throws for a URL that cannot be used: every call answers not-configured and reaches nothing", async () => {
    const { calls, impl } = fake();
    for (const url of ["", "not a url", "ftp://x.test", "https://u:p@x.test", `${BASE}/?q=1`, `${BASE}/#f`]) {
      let built: DocusealClient | undefined;
      assert.doesNotThrow(() => {
        built = createDocusealClient({ url, token: TOKEN, fetch: impl });
      }, url);
      assert.deepEqual(failure(await built!.findTemplateByName("n")), { kind: "not-configured" }, url);
      assert.deepEqual(failure(await built!.getSubmission(1)), { kind: "not-configured" }, url);
      assert.deepEqual(failure(await built!.downloadDocument(`${BASE}/f`)), { kind: "not-configured" }, url);
    }
    assert.equal(calls.length, 0);
  });

  it("validates and clamps the time limit and never above MAX_TIMEOUT_MS (the longest-send bound relies on it): a bad value falls back to the default and never makes a call reject", async (t: TestContext) => {
    const limits: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, "timeout", (ms: number) => (limits.push(ms), original(Math.min(Math.max(ms, 0), 1_000))));
    const cases: [unknown, number][] = [
      [Number.NaN, 30_000],
      [Number.POSITIVE_INFINITY, 30_000],
      [-5, 30_000],
      [0, 30_000],
      ["5", 30_000],
      [undefined, 30_000],
      [1e12, MAX_TIMEOUT_MS],
      [MAX_TIMEOUT_MS + 1, MAX_TIMEOUT_MS],
      [250, 250],
    ];
    for (const [timeoutMs] of cases) {
      const { impl } = fake(json({ status: "pending" }));
      const result = await createDocusealClient({ url: BASE, token: TOKEN, fetch: impl, timeoutMs: timeoutMs as number }).getSubmission(1);
      assert.equal(result.ok, true, String(timeoutMs));
    }
    assert.deepEqual(
      limits,
      cases.map(([, expected]) => expected),
    );
  });
});

describe("findTemplateByName", () => {
  it("lists templates filtered by name and sends the token, JSON accept and a browser-like user agent", async () => {
    const { calls, impl } = fake(json({ data: [] }));
    await client(impl).findTemplateByName("NDA-2026-001-beta");
    const call = calls[0]!;
    assert.equal(call.method, "GET");
    assert.equal(call.url, `${BASE}/api/templates?limit=100&q=NDA-2026-001-beta`);
    assert.equal(call.headers["x-auth-token"], TOKEN);
    assert.equal(call.headers.accept, "application/json");
    assert.match(call.headers["user-agent"]!, /^Mozilla\/5\.0 /);
    assert.equal(call.body, undefined);
    assert.equal(call.redirect, "manual");
    assert.ok(call.signal, "a timeout signal is attached");
  });

  it("encodes the name in the query", async () => {
    const { calls, impl } = fake(json({ data: [] }));
    await client(impl).findTemplateByName("a b&c=d#e");
    assert.equal(calls[0]!.url, `${BASE}/api/templates?limit=100&q=a%20b%26c%3Dd%23e`);
  });

  it("takes the exact name only, and the highest id when several match", async () => {
    const { impl } = fake(
      json({
        data: [
          { id: 3, name: "NDA-2026-001-beta" },
          { id: 9, name: "NDA-2026-001-beta" },
          { id: 12, name: "NDA-2026-001-beta-2" },
          { id: 15, name: "nda-2026-001-beta" },
          { id: 5, name: "NDA-2026-001-beta" },
        ],
      }),
    );
    assert.deepEqual(success(await client(impl).findTemplateByName("NDA-2026-001-beta")), { id: 9 });
  });

  it("answers null when no template has the name", async () => {
    const { impl } = fake(json({ data: [{ id: 1, name: "other" }] }));
    assert.equal(success(await client(impl).findTemplateByName("NDA-2026-001-beta")), null);
  });

  it("ignores list entries that have no usable id or name, and refuses an answer that is not a list", async () => {
    const odd = fake(json({ data: [{ id: "7", name: "n" }, { id: -1, name: "n" }, { id: 1.5, name: "n" }, { name: "n" }, null, "x", { id: 4, name: "n" }] }));
    assert.deepEqual(success(await client(odd.impl).findTemplateByName("n")), { id: 4 });
    for (const body of [{}, { data: "x" }, [], "text", null]) {
      assert.equal(failure(await client(fake(json(body)).impl).findTemplateByName("n")).kind, "unexpected", JSON.stringify(body));
    }
  });
});

describe("getTemplate", () => {
  it("reads the attachment uuid of the first document and the uuids of the submitters", async () => {
    const { calls, impl } = fake(json({ id: 42, schema: [{ attachment_uuid: "att-1", name: "x" }, { attachment_uuid: "att-2" }], submitters: [{ uuid: "sub-a", name: "A" }, { uuid: "sub-b" }] }));
    assert.deepEqual(success(await client(impl).getTemplate(42)), { attachmentUuid: "att-1", submitterUuids: ["sub-a", "sub-b"] });
    assert.deepEqual([calls[0]!.method, calls[0]!.url], ["GET", `${BASE}/api/templates/42`]);
  });

  it("allows a template with no submitters yet", async () => {
    assert.deepEqual(success(await client(fake(json({ schema: [{ attachment_uuid: "att" }] })).impl).getTemplate(1)).submitterUuids, []);
    assert.deepEqual(success(await client(fake(json({ schema: [{ attachment_uuid: "att" }], submitters: [{ name: "no uuid" }, { uuid: 5 }] })).impl).getTemplate(1)).submitterUuids, []);
  });

  it("refuses a template without a document, and an attachment uuid that is not a plain token", async () => {
    for (const body of [{}, { schema: [] }, { schema: [{}] }, { schema: [{ attachment_uuid: "../x" }] }, { schema: [{ attachment_uuid: 7 }] }, { schema: "x" }]) {
      assert.equal(failure(await client(fake(json(body)).impl).getTemplate(1)).kind, "unexpected", JSON.stringify(body));
    }
  });

  it("refuses an id that is not a positive integer without calling DocuSeal", async () => {
    const { calls, impl } = fake();
    for (const id of [0, -1, 1.5, Number.NaN, 2 ** 60]) assert.equal(failure(await client(impl).getTemplate(id)).kind, "unexpected", String(id));
    assert.equal(calls.length, 0);
  });
});

describe("updateTemplate", () => {
  const update = {
    submitters: [
      { name: "Acme", uuid: "u-a" },
      { name: "Beta", uuid: "u-b" },
    ],
    fields: [{ uuid: "f1", submitter_uuid: "u-a", required: true as const, name: "Firma Acme", type: "signature" as const, areas: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04, page: 2, attachment_uuid: "att" }] }],
  };

  it("puts the submitters and the fields as JSON", async () => {
    const { calls, impl } = fake(json({ id: 42 }));
    assert.equal(success(await client(impl).updateTemplate(42, update)), null);
    const call = calls[0]!;
    assert.deepEqual([call.method, call.url, call.headers["content-type"]], ["PUT", `${BASE}/api/templates/42`, "application/json"]);
    assert.deepEqual(JSON.parse(call.body!), update);
  });

  it("accepts an empty answer body", async () => {
    assert.equal(success(await client(fake(new Response(null, { status: 200 })).impl).updateTemplate(42, update)), null);
  });
});

describe("createSubmission", () => {
  const request = { templateId: 42, order: "preserved" as const, submitters: [{ role: "Acme", name: "Ana", email: "ana@acme.test" }, { role: "Beta", name: "Ben", email: "ben@beta.test" }] };
  const answer = [
    { id: 11, submission_id: 77, role: "Acme", email: "ana@acme.test", embed_src: "https://sign.example.test/s/aaa" },
    { id: 12, submission_id: 77, role: "Beta", email: "ben@beta.test", embed_src: "https://sign.example.test/s/bbb" },
  ];

  it("posts the template, no email, the order and the signers in the given order", async () => {
    const { calls, impl } = fake(json(answer));
    await client(impl).createSubmission(request);
    const call = calls[0]!;
    assert.deepEqual([call.method, call.url], ["POST", `${BASE}/api/submissions`]);
    assert.deepEqual(JSON.parse(call.body!), { template_id: 42, send_email: false, order: "preserved", submitters: request.submitters });
  });

  it("reads the submission id and each signer's role and link, from a list", async () => {
    assert.deepEqual(success(await client(fake(json(answer)).impl).createSubmission(request)), {
      submissionId: 77,
      submitters: [
        { role: "Acme", link: "https://sign.example.test/s/aaa" },
        { role: "Beta", link: "https://sign.example.test/s/bbb" },
      ],
    });
  });

  it("also reads the signers from an object with a submitters list", async () => {
    assert.equal(success(await client(fake(json({ submitters: answer })).impl).createSubmission(request)).submissionId, 77);
  });

  it("accepts a link on another host (the application URL may differ), but only http or https", async () => {
    const other = answer.map((s) => ({ ...s, embed_src: `http://192.0.2.10:3000/s/${s.id}` }));
    assert.equal(success(await client(fake(json(other)).impl).createSubmission(request)).submitters[0]!.link, "http://192.0.2.10:3000/s/11");
    for (const bad of ["javascript:alert(1)", "data:text/html,<b>", "//evil.test/x", "/s/aaa", "", 5, null]) {
      const answers = [{ ...answer[0]!, embed_src: bad }, answer[1]!];
      assert.deepEqual(failure(await client(fake(json(answers)).impl).createSubmission(request)), { kind: "outcome-unknown", reason: "unreadable" }, String(bad));
    }
  });

  it("refuses an answer that does not have both signers with a role, a link and the same submission id", async () => {
    const bad: unknown[] = [
      [],
      [answer[0]],
      [answer[0], { ...answer[1]!, submission_id: 78 }],
      [answer[0], { ...answer[1]!, submission_id: "77" }],
      [answer[0], { ...answer[1]!, role: undefined }],
      [answer[0], { ...answer[1]!, role: "Acme" }],
      [answer[0], { ...answer[1]!, role: "Someone else" }],
      { id: 1 },
      "ok",
    ];
    for (const body of bad) assert.deepEqual(failure(await client(fake(json(body)).impl).createSubmission(request)), { kind: "outcome-unknown", reason: "unreadable" }, JSON.stringify(body));
  });

  describe("when the request may have been applied", () => {
    it("reports a timeout while waiting as an unknown outcome", async () => {
      const hang = (_c: Call, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      assert.deepEqual(failure(await client(fake(hang).impl, { timeoutMs: 20 }).createSubmission(request)), { kind: "outcome-unknown", reason: "timeout" });
    });

    it("reports a dropped connection as an unknown outcome", async () => {
      assert.deepEqual(failure(await client(fake(() => Promise.reject(new TypeError("fetch failed"))).impl).createSubmission(request)), { kind: "outcome-unknown", reason: "network" });
    });

    it("reports a body that is interrupted after a 2xx as an unknown outcome, and a body that times out the same way", async () => {
      const broken = () => new Response(new ReadableStream({ start: (controller) => controller.error(new TypeError("terminated")) }), { status: 201 });
      assert.deepEqual(failure(await client(fake(broken).impl).createSubmission(request)), { kind: "outcome-unknown", reason: "interrupted" });
      const slow = (_c: Call, init: RequestInit) => new Response(new ReadableStream({ start: (controller) => init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason)) }), { status: 200 });
      assert.deepEqual(failure(await client(fake(slow).impl, { timeoutMs: 20 }).createSubmission(request)), { kind: "outcome-unknown", reason: "timeout" });
    });

    it("reports an answer that is not JSON, empty or too large, after a 2xx, as an unknown outcome", async () => {
      for (const body of ["<html>", "", "   "]) {
        assert.deepEqual(failure(await client(fake(new Response(body, { status: 200 })).impl).createSubmission(request)), { kind: "outcome-unknown", reason: "unreadable" }, JSON.stringify(body));
      }
      const huge = new Response("x", { status: 200, headers: { "content-length": String(10 * 1024 * 1024) } });
      assert.deepEqual(failure(await client(fake(huge).impl).createSubmission(request)), { kind: "outcome-unknown", reason: "unreadable" });
    });

    it("keeps a refusal that carries a status as the refusal it is: nothing was created", async () => {
      assert.deepEqual(failure(await client(fake(json({ error: "x" }, 422)).impl).createSubmission(request)), { kind: "rejected", status: 422 });
      assert.deepEqual(failure(await client(fake(json({ error: "x" }, 401)).impl).createSubmission(request)), { kind: "unauthorized", status: 401 });
      assert.deepEqual(failure(await client(fake(json({ error: "x" }, 503)).impl).createSubmission(request)), { kind: "server-error", status: 503 });
    });

    it("leaves the reads as they were: a timeout on a read is plain unreachable", async () => {
      const hang = (_c: Call, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      assert.deepEqual(failure(await client(fake(hang).impl, { timeoutMs: 20 }).getSubmission(1)), { kind: "unreachable", reason: "timeout" });
    });
  });
});

describe("getSubmission", () => {
  it("reads the status, the completion time and each signer's role, email, status and time", async () => {
    const { calls, impl } = fake(
      json({
        id: 77,
        status: "pending",
        completed_at: null,
        submitters: [
          { role: "Acme", email: "ana@acme.test", status: "completed", completed_at: "2026-10-12T10:00:00.000Z", opened_at: "2026-10-12T09:00:00.000Z" },
          { role: "Beta", email: "ben@beta.test", status: "opened", opened_at: "2026-10-12T09:30:00.000Z" },
          { role: "Gamma", status: "sent" },
        ],
      }),
    );
    assert.deepEqual(success(await client(impl).getSubmission(77)), {
      status: "pending",
      completedAt: null,
      signers: [
        { role: "Acme", email: "ana@acme.test", status: "completed", at: "2026-10-12T10:00:00.000Z" },
        { role: "Beta", email: "ben@beta.test", status: "opened", at: "2026-10-12T09:30:00.000Z" },
        { role: "Gamma", email: null, status: "sent", at: null },
      ],
    });
    assert.deepEqual([calls[0]!.method, calls[0]!.url], ["GET", `${BASE}/api/submissions/77`]);
  });

  it("reads a submission with no signers list, and ignores times that are not dates", async () => {
    assert.deepEqual(success(await client(fake(json({ status: "completed", completed_at: "2026-10-12T10:00:00Z" })).impl).getSubmission(1)), { status: "completed", completedAt: "2026-10-12T10:00:00.000Z", signers: [] });
    const odd = success(await client(fake(json({ status: "pending", completed_at: "tomorrow", submitters: [{ role: "A", status: "completed", completed_at: "nope" }] })).impl).getSubmission(1));
    assert.deepEqual([odd.completedAt, odd.signers[0]!.at], [null, null]);
  });

  it("accepts a time only in an ISO date-time shape and stores it in normalized ISO form", async () => {
    const read = async (value: unknown) => success(await client(fake(json({ status: "pending", completed_at: value })).impl).getSubmission(1)).completedAt;
    assert.equal(await read("2026-10-12T10:00:00Z"), "2026-10-12T10:00:00.000Z");
    assert.equal(await read("2026-10-12T10:00:00.5Z"), "2026-10-12T10:00:00.500Z");
    assert.equal(await read("2026-10-12T12:00:00+02:00"), "2026-10-12T10:00:00.000Z");
    assert.equal(await read("2026-10-12T12:00+0200"), "2026-10-12T10:00:00.000Z");
    for (const bad of ["1", "2026", "Oct 12 2026", "12/10/2026", "2026-10-12", "2026-10-12 10:00:00", "2026-10-12T10:00:00", "2026-02-31T10:00:00Z", "2026-13-01T10:00:00Z", "2026-10-12T24:00:00Z", "2026-10-12T10:00:00Zjunk", "Tue, 13 Oct 2026 10:00:00 GMT", 1791792000000, null]) {
      assert.equal(await read(bad), null, String(bad));
    }
  });

  it("refuses an answer without a text status", async () => {
    for (const body of [{}, { status: 3 }, { status: "" }, [], null]) assert.equal(failure(await client(fake(json(body)).impl).getSubmission(1)).kind, "unexpected", JSON.stringify(body));
  });
});

describe("listDocuments", () => {
  it("reads the documents of a submission with their URL and name", async () => {
    const { calls, impl } = fake(json({ documents: [{ name: "NDA", url: `${BASE}/file/abc/NDA.pdf` }, { url: `${BASE}/file/def/log.pdf` }] }));
    assert.deepEqual(success(await client(impl).listDocuments(77)), [
      { url: `${BASE}/file/abc/NDA.pdf`, name: "NDA" },
      { url: `${BASE}/file/def/log.pdf`, name: null },
    ]);
    assert.deepEqual([calls[0]!.method, calls[0]!.url], ["GET", `${BASE}/api/submissions/77/documents`]);
  });

  it("answers an empty list only when DocuSeal says the list is empty", async () => {
    assert.deepEqual(success(await client(fake(json({ documents: [] })).impl).listDocuments(1)), []);
  });

  it("refuses an answer that is not an object, or has no documents key, instead of reading it as an empty list", async () => {
    for (const body of [{}, [], [{ url: `${BASE}/f` }], "text", 7, null, { id: 77 }, { documents: null }]) {
      assert.equal(failure(await client(fake(json(body)).impl).listDocuments(1)).kind, "unexpected", JSON.stringify(body));
    }
  });

  it("refuses a malformed documents value or entry", async () => {
    for (const body of [{ documents: "x" }, { documents: [{}] }, { documents: [{ url: 5 }] }, { documents: [{ url: "not a url" }] }, { documents: [null] }]) {
      assert.equal(failure(await client(fake(json(body)).impl).listDocuments(1)).kind, "unexpected", JSON.stringify(body));
    }
  });
});

describe("downloadDocument", () => {
  const pdf = () => new Response(new TextEncoder().encode("%PDF-1.7 signed"), { status: 200, headers: { "content-type": "application/pdf" } });

  it("fetches a document of the same origin without the token, as the skill does", async () => {
    const { calls, impl } = fake(pdf());
    const bytes = success(await client(impl).downloadDocument(`${BASE}/file/abc/NDA.pdf`));
    assert.equal(new TextDecoder().decode(bytes), "%PDF-1.7 signed");
    assert.equal(calls[0]!.url, `${BASE}/file/abc/NDA.pdf`);
    assert.equal(calls[0]!.headers["x-auth-token"], undefined);
    assert.equal(calls[0]!.redirect, "manual");
  });

  it("refuses any other origin without calling it: host, port, scheme, credentials and non-http schemes", async () => {
    const { calls, impl } = fake();
    for (const url of ["https://evil.test/a.pdf", "https://sign.example.test:8443/a.pdf", "http://sign.example.test/a.pdf", "https://sign.example.test.evil.test/a.pdf", "https://user@evil.test/a.pdf", "file:///etc/passwd", "javascript:alert(1)", "/relative.pdf", "not a url", ""]) {
      assert.deepEqual(failure(await client(impl).downloadDocument(url)), { kind: "refused-url" }, url);
    }
    assert.equal(calls.length, 0);
  });

  it("refuses an answer that is not a PDF or is too large", async () => {
    assert.equal(failure(await client(fake(new Response("<html>login</html>", { status: 200 })).impl).downloadDocument(`${BASE}/f`)).kind, "unexpected");
    const huge = new Response("%PDF-", { status: 200, headers: { "content-length": String(200 * 1024 * 1024) } });
    assert.equal(failure(await client(fake(huge).impl).downloadDocument(`${BASE}/f`)).kind, "unexpected");
  });

  it("counts the size in bytes and stops reading once the cap is passed, with or without a content-length header", async () => {
    const MB = 1024 * 1024;
    const endless = () => {
      const state = { pulled: 0, cancelled: false };
      const chunk = new Uint8Array(MB);
      chunk.set(new TextEncoder().encode("%PDF-"));
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          state.pulled += 1;
          controller.enqueue(chunk);
          // Finite on purpose, so a reader that does not stop ends instead of exhausting memory.
          if (state.pulled >= 80) controller.close();
        },
        cancel() {
          state.cancelled = true;
        },
      });
      return { state, body };
    };
    for (const headers of [{}, { "content-length": "100" }] as Record<string, string>[]) {
      const { state, body } = endless();
      const result = await client(fake(new Response(body, { status: 200, headers })).impl).downloadDocument(`${BASE}/f`);
      assert.deepEqual(failure(result), { kind: "unexpected", what: "size" }, JSON.stringify(headers));
      assert.equal(state.cancelled, true, "the stream is cancelled");
      assert.ok(state.pulled <= 52, `read ${state.pulled} MB before stopping`);
    }
    const exact = new Uint8Array(50 * MB);
    exact.set(new TextEncoder().encode("%PDF-"));
    const whole = await client(fake(new Response(exact, { status: 200 })).impl).downloadDocument(`${BASE}/f`);
    assert.ok(whole.ok && whole.value.length === 50 * MB, "a file of exactly the cap is accepted");
  });

  it("maps the status of a failed download like any other call", async () => {
    assert.deepEqual(failure(await client(fake(new Response("", { status: 404 })).impl).downloadDocument(`${BASE}/f`)), { kind: "not-found" });
    assert.deepEqual(failure(await client(fake(new Response("", { status: 502 })).impl).downloadDocument(`${BASE}/f`)), { kind: "server-error", status: 502 });
  });
});

describe("failures", () => {
  const call = (impl: typeof fetch) => client(impl).getSubmission(1);

  it("maps the status to a typed result", async () => {
    const cases: [number, DocusealError][] = [
      [401, { kind: "unauthorized", status: 401 }],
      [403, { kind: "unauthorized", status: 403 }],
      [404, { kind: "not-found" }],
      [400, { kind: "rejected", status: 400 }],
      [422, { kind: "rejected", status: 422 }],
      [429, { kind: "rejected", status: 429 }],
      [500, { kind: "server-error", status: 500 }],
      [503, { kind: "server-error", status: 503 }],
    ];
    for (const [status, expected] of cases) assert.deepEqual(failure(await call(fake(json({ error: "x" }, status)).impl)), expected, String(status));
  });

  it("maps a network failure and a timeout to unreachable", async () => {
    assert.deepEqual(failure(await call(fake(() => Promise.reject(new TypeError("fetch failed"))).impl)), { kind: "unreachable", reason: "network" });
    const hang = (_c: Call, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    assert.deepEqual(failure(await client(fake(hang).impl, { timeoutMs: 20 }).getSubmission(1)), { kind: "unreachable", reason: "timeout" });
  });

  it("times out while the body is still being read", async () => {
    const slow = (_c: Call, init: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body, { status: 200 });
    };
    assert.deepEqual(failure(await client(fake(slow).impl, { timeoutMs: 20 }).getSubmission(1)), { kind: "unreachable", reason: "timeout" });
  });

  it("counts a JSON answer in bytes and stops reading once the cap is passed, with or without a content-length header", async () => {
    // 2.7 million two-byte characters are under 5 MB as text and over it as bytes.
    const wide = JSON.stringify({ status: "pending", note: "é".repeat(2_700_000) });
    assert.deepEqual(failure(await call(fake(new Response(wide, { status: 200 })).impl)), { kind: "unexpected", what: "size" });
    for (const headers of [{}, { "content-length": "100" }] as Record<string, string>[]) {
      const state = { pulled: 0, cancelled: false };
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          state.pulled += 1;
          controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
          if (state.pulled >= 12) controller.close();
        },
        cancel() {
          state.cancelled = true;
        },
      });
      assert.deepEqual(failure(await call(fake(new Response(body, { status: 200, headers })).impl)), { kind: "unexpected", what: "size" }, JSON.stringify(headers));
      assert.equal(state.cancelled, true);
      assert.ok(state.pulled <= 7, `read ${state.pulled} MB before stopping`);
    }
  });

  it("refuses a success answer that is not JSON", async () => {
    assert.equal(failure(await call(fake(new Response("<html>", { status: 200 })).impl)).kind, "unexpected");
  });

  it("never carries the token in a result, a log line or a request URL, whatever the failure", async () => {
    const logged: unknown[][] = [];
    const originals = { error: console.error, warn: console.warn, log: console.log };
    for (const name of ["error", "warn", "log"] as const) console[name] = (...args: unknown[]) => void logged.push(args);
    try {
      const answers: Answer[] = [() => Promise.reject(new Error(`boom ${TOKEN}`)), json({ error: `bad token ${TOKEN}` }, 401), json({ error: TOKEN }, 500), json({ error: TOKEN }, 422), new Response(TOKEN, { status: 200 })];
      const seen: unknown[] = [];
      for (const answer of answers) seen.push(await call(fake(answer).impl));
      const { calls, impl } = fake(json({ data: [] }));
      await client(impl).findTemplateByName("n");
      assert.doesNotMatch(JSON.stringify([seen, logged, calls.map((c) => c.url)]), new RegExp(TOKEN));
    } finally {
      Object.assign(console, originals);
    }
  });
});

describe("redirects", () => {
  it("follows a redirect to the same origin for a read, sending the token again only to that origin", async () => {
    const { calls, impl } = fake(new Response(null, { status: 302, headers: { location: "/api/submissions/1/" } }), json({ status: "pending" }));
    assert.equal(success(await client(impl).getSubmission(1)).status, "pending");
    assert.deepEqual(
      calls.map((c) => [c.url, c.headers["x-auth-token"]]),
      [
        [`${BASE}/api/submissions/1`, TOKEN],
        [`${BASE}/api/submissions/1/`, TOKEN],
      ],
    );
  });

  it("refuses a redirect to another origin without sending the token there", async () => {
    for (const location of ["https://evil.test/steal", "http://sign.example.test/x", "https://sign.example.test:444/x", "//evil.test/x"]) {
      const { calls, impl } = fake(new Response(null, { status: 307, headers: { location } }), json({ status: "pending" }));
      assert.deepEqual(failure(await client(impl).getSubmission(1)), { kind: "refused-url" }, location);
      assert.equal(calls.length, 1, location);
    }
  });

  it("does not follow a redirect of a write, and stops a chain of redirects", async () => {
    const write = fake(new Response(null, { status: 307, headers: { location: "/api/templates/1" } }), json({}));
    assert.equal(failure(await client(write.impl).updateTemplate(1, { submitters: [], fields: [] })).kind, "unexpected");
    assert.equal(write.calls.length, 1);
    const loop = fake(...Array.from({ length: 6 }, () => new Response(null, { status: 302, headers: { location: "/api/submissions/1" } })));
    assert.equal(failure(await client(loop.impl).getSubmission(1)).kind, "unexpected");
    assert.ok(loop.calls.length <= 4);
  });

  it("treats a redirect without a usable location as an unexpected answer", async () => {
    assert.equal(failure(await client(fake(new Response(null, { status: 302 })).impl).getSubmission(1)).kind, "unexpected");
    assert.equal(failure(await client(fake(new Response(null, { status: 302, headers: { location: "http://[bad" } })).impl).getSubmission(1)).kind, "unexpected");
  });
});
