/**
 * The DocuSeal REST client, ported from the /nda skill (`scripts/nda.py`, class `DocuSeal`). It is configured from the
 * environment only (`DOCUSEAL_URL`, `DOCUSEAL_API_TOKEN`), takes `fetch` as a dependency so tests never reach a network,
 * and never throws: every failure is a typed result. The token goes in one header to the configured origin and nowhere
 * else: redirects are followed by hand and only inside that origin, and no result, message or log line carries it.
 * Answers are validated before use, and nothing from an answer is used as a path or as markup.
 */

export type DocusealError =
  | { kind: "not-configured" }
  | { kind: "unreachable"; reason: "timeout" | "network" }
  | { kind: "unauthorized"; status: number }
  | { kind: "not-found" }
  | { kind: "rejected"; status: number }
  | { kind: "server-error"; status: number }
  | { kind: "unexpected"; what: string }
  /**
   * A request that creates something may have been applied even though no usable answer came back: the wait timed out,
   * the connection dropped, the body was cut after a 2xx, or the answer could not be read. The caller must treat the
   * thing as possibly created and never as a clean failure.
   */
  | { kind: "outcome-unknown"; reason: "timeout" | "network" | "interrupted" | "unreadable" }
  /** A URL, or a redirect, that leaves the configured origin. */
  | { kind: "refused-url" };

export type DocusealResult<T> = { ok: true; value: T } | { ok: false; error: DocusealError };

export interface TemplateFieldPayload {
  uuid: string;
  submitter_uuid: string;
  required: true;
  name: string;
  type: "signature" | "date";
  areas: { x: number; y: number; w: number; h: number; page: number; attachment_uuid: string }[];
}

export interface TemplateUpdate {
  submitters: { name: string; uuid: string }[];
  fields: TemplateFieldPayload[];
}

/** DocuSeal's `order` of a submission: any order, or the order of the submitters list. */
export type SigningOrder = "random" | "preserved";

export interface SubmissionRequest {
  templateId: number;
  order: SigningOrder;
  submitters: { role: string; name: string; email: string }[];
}

export interface SubmissionSigner {
  role: string | null;
  email: string | null;
  status: string | null;
  /** The time of the signer's completion, else of their opening (what the skill prints), as an ISO string. */
  at: string | null;
}

export interface DocusealClient {
  /** The newest template whose name is exactly `name`, or null. */
  findTemplateByName(name: string): Promise<DocusealResult<{ id: number } | null>>;
  getTemplate(id: number): Promise<DocusealResult<{ attachmentUuid: string; submitterUuids: string[] }>>;
  updateTemplate(id: number, update: TemplateUpdate): Promise<DocusealResult<null>>;
  /** Creates a submission that sends no email. */
  createSubmission(request: SubmissionRequest): Promise<DocusealResult<{ submissionId: number; submitters: { role: string; link: string }[] }>>;
  getSubmission(id: number): Promise<DocusealResult<{ status: string; completedAt: string | null; signers: SubmissionSigner[] }>>;
  listDocuments(submissionId: number): Promise<DocusealResult<{ url: string; name: string | null }[]>>;
  /** Only a URL on the configured origin is fetched, and without the token (the skill's download sends none either). */
  downloadDocument(url: string): Promise<DocusealResult<Uint8Array>>;
}

export interface DocusealConfig {
  url: string;
  token: string;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** The longest limit one request can run under, whatever is configured: a larger setting is lowered to this. */
export const MAX_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 3;
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
/** Cloudflare blocks the default agent of some HTTP clients; the skill sends this kind of value for the same reason. */
const USER_AGENT = "Mozilla/5.0 (compatible; documents-module/1.0)";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const fail = (error: DocusealError): { ok: false; error: DocusealError } => ({ ok: false, error });
const unexpected = (what: string) => fail({ kind: "unexpected", what });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
/** An identifier DocuSeal made: letters, digits and hyphens. */
const token = (value: unknown): string | null => (typeof value === "string" && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : null);
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/;
/**
 * A time from an answer: accepted only as an ISO 8601 date and time with a zone (a bare date, a date without a zone or any
 * other spelling is not a time), a real calendar day, and returned in normalized ISO form (UTC, milliseconds).
 */
export const toIsoTime = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const match = ISO_DATE_TIME.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
};
const isoTime = toIsoTime;
/** A link to show to the owner: absolute, http or https. It may be on another host than the API (DocuSeal's application URL). */
const webLink = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
};

function parseBase(raw: string | undefined): URL | null {
  const trimmed = raw?.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    // A query or a fragment (even an empty one, which `URL` hides) would be glued into every path built from the base.
    if (trimmed.includes("?") || trimmed.includes("#")) return null;
    const url = new URL(trimmed);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/** A finite positive limit, else the default, and never above `MAX_TIMEOUT_MS`: the send service's longest-send bound relies on it. */
const clampLimit = (limit: unknown): number => Math.min(typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

type Sent = { ok: true; response: Response; signal: AbortSignal } | { ok: false; error: DocusealError };

/** The client used when the URL cannot be used: every call says signing is not configured and reaches nothing. */
function unconfiguredClient(): DocusealClient {
  const no = () => Promise.resolve(fail({ kind: "not-configured" }));
  return { findTemplateByName: no, getTemplate: no, updateTemplate: no, createSubmission: no, getSubmission: no, listDocuments: no, downloadDocument: no };
}

/** Never throws: a URL that cannot be used gives a client whose calls answer `not-configured`. */
export function createDocusealClient(config: DocusealConfig): DocusealClient {
  const base = parseBase(config.url);
  if (base === null) return unconfiguredClient();
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = clampLimit(config.timeoutMs);
  const origin = base.origin;
  const prefix = base.href.replace(/\/+$/, "");

  const isTimeout = (error: unknown) => ["TimeoutError", "AbortError"].includes((error as { name?: string } | null)?.name ?? "");
  const interrupted = (error: unknown) => fail({ kind: "unreachable", reason: isTimeout(error) ? "timeout" : "network" });

  /**
   * One request with a time limit. A redirect inside the origin is followed for a read, up to three times; a redirect
   * to any other origin is refused before anything is sent there, and a redirect of a write is not followed at all.
   */
  async function send(target: URL, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Sent> {
    const signal = AbortSignal.timeout(timeoutMs);
    let current = target;
    for (let hop = 0; ; hop += 1) {
      let response: Response;
      try {
        response = await doFetch(current.href, { ...init, redirect: "manual", signal });
      } catch (error) {
        return interrupted(error);
      }
      if (!REDIRECTS.has(response.status)) return { ok: true, response, signal };
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      let next: URL;
      try {
        next = new URL(location ?? "", current);
      } catch {
        return unexpected("redirect");
      }
      if (location === null) return unexpected("redirect");
      if (next.origin !== origin) return fail({ kind: "refused-url" });
      if (init.method !== "GET" || hop >= MAX_REDIRECTS) return unexpected("redirect");
      current = next;
    }
  }

  const failureOf = (status: number): DocusealError | null => {
    if (status >= 200 && status < 300) return null;
    if (status === 401 || status === 403) return { kind: "unauthorized", status };
    if (status === 404) return { kind: "not-found" };
    if (status >= 400 && status < 500) return { kind: "rejected", status };
    if (status >= 500) return { kind: "server-error", status };
    return { kind: "unexpected", what: "status" };
  };

  /**
   * The body of a response, counted in bytes: refused from the declared length when it is already over the cap, and
   * otherwise read chunk by chunk and cancelled the moment the cap is passed, so memory never holds more than the cap
   * plus one chunk, whatever the headers say.
   */
  async function readBounded(response: Response, max: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: "size" | "interrupted"; cause?: unknown }> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > max) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, error: "size" };
    }
    if (response.body === null) return { ok: true, bytes: new Uint8Array(0) };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          await reader.cancel().catch(() => {});
          return { ok: false, error: "size" };
        }
        chunks.push(value);
      }
    } catch (cause) {
      return { ok: false, error: "interrupted", cause };
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes };
  }

  /**
   * An API call: JSON in, JSON out. An empty success body is `{}`. With `mayApply`, a request that creates something:
   * once it was sent, any outcome without a usable answer (timeout, dropped connection, cut or unreadable body) is
   * `outcome-unknown` instead of a plain failure, because the thing may exist.
   */
  async function api(method: string, path: string, body?: unknown, mayApply = false): Promise<DocusealResult<unknown>> {
    const unknownOutcome = (reason: "timeout" | "network" | "interrupted" | "unreadable") => fail({ kind: "outcome-unknown", reason });
    const headers: Record<string, string> = { "X-Auth-Token": config.token, Accept: "application/json", "User-Agent": USER_AGENT };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const sent = await send(new URL(`${prefix}/api${path}`), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!sent.ok) {
      if (mayApply && sent.error.kind === "unreachable") return unknownOutcome(sent.error.reason);
      return sent;
    }
    const failed = failureOf(sent.response.status);
    if (failed) {
      await sent.response.body?.cancel().catch(() => {});
      return fail(failed);
    }
    const read = await readBounded(sent.response, MAX_JSON_BYTES);
    if (!read.ok) {
      if (read.error === "size") return mayApply ? unknownOutcome("unreadable") : unexpected("size");
      if (mayApply) return unknownOutcome(isTimeout(read.cause) ? "timeout" : "interrupted");
      return interrupted(read.cause);
    }
    const raw = new TextDecoder().decode(read.bytes);
    if (raw.trim() === "") return mayApply ? unknownOutcome("unreadable") : { ok: true, value: {} };
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch {
      return mayApply ? unknownOutcome("unreadable") : unexpected("json");
    }
  }

  const withId = async <T>(id: number, run: () => Promise<DocusealResult<T>>): Promise<DocusealResult<T>> => (isId(id) ? run() : unexpected("id"));

  return {
    async findTemplateByName(name) {
      const answer = await api("GET", `/templates?limit=100&q=${encodeURIComponent(name)}`);
      if (!answer.ok) return answer;
      if (!isRecord(answer.value) || !Array.isArray(answer.value.data)) return unexpected("templates");
      // The skill's rule: the exact name; the newest (highest id) when several match.
      let best: number | null = null;
      for (const entry of answer.value.data) {
        if (isRecord(entry) && entry.name === name && isId(entry.id) && (best === null || entry.id > best)) best = entry.id;
      }
      return { ok: true, value: best === null ? null : { id: best } };
    },

    getTemplate: (id) =>
      withId(id, async () => {
        const answer = await api("GET", `/templates/${id}`);
        if (!answer.ok) return answer;
        const data = answer.value;
        const first = isRecord(data) && Array.isArray(data.schema) ? data.schema[0] : undefined;
        const attachmentUuid = isRecord(first) ? token(first.attachment_uuid) : null;
        if (attachmentUuid === null) return unexpected("template document");
        const listed = isRecord(data) && Array.isArray(data.submitters) ? data.submitters : [];
        const submitterUuids = listed.flatMap((entry) => (isRecord(entry) && token(entry.uuid) !== null ? [entry.uuid as string] : []));
        return { ok: true, value: { attachmentUuid, submitterUuids } };
      }),

    updateTemplate: (id, update) =>
      withId(id, async () => {
        const answer = await api("PUT", `/templates/${id}`, update);
        return answer.ok ? { ok: true, value: null } : answer;
      }),

    async createSubmission(request) {
      if (!isId(request.templateId)) return unexpected("id");
      const answer = await api("POST", "/submissions", { template_id: request.templateId, send_email: false, order: request.order, submitters: request.submitters }, true);
      if (!answer.ok) return answer;
      // From here the submission exists in DocuSeal; an answer that cannot be read is an unknown outcome, never a clean failure.
      const unreadable = fail({ kind: "outcome-unknown", reason: "unreadable" });
      // The skill reads a list of submitters, or an object that holds one; each carries `submission_id`, `role` and `embed_src`.
      const items = Array.isArray(answer.value) ? answer.value : isRecord(answer.value) && Array.isArray(answer.value.submitters) ? answer.value.submitters : null;
      if (items === null || items.length !== request.submitters.length) return unreadable;
      let submissionId: number | null = null;
      const roles = new Set<string>();
      const submitters: { role: string; link: string }[] = [];
      for (const item of items) {
        const role = isRecord(item) ? text(item.role) : null;
        const link = isRecord(item) ? webLink(item.embed_src) : null;
        const id = isRecord(item) ? item.submission_id : null;
        if (role === null || link === null || !isId(id) || (submissionId !== null && id !== submissionId) || roles.has(role)) return unreadable;
        submissionId = id;
        roles.add(role);
        submitters.push({ role, link });
      }
      if (submissionId === null || !request.submitters.every((signer) => roles.has(signer.role))) return unreadable;
      return { ok: true, value: { submissionId, submitters } };
    },

    getSubmission: (id) =>
      withId(id, async () => {
        const answer = await api("GET", `/submissions/${id}`);
        if (!answer.ok) return answer;
        const data = answer.value;
        const status = isRecord(data) ? text(data.status) : null;
        if (!isRecord(data) || status === null) return unexpected("submission");
        const listed = Array.isArray(data.submitters) ? data.submitters : [];
        const signers = listed.filter(isRecord).map((entry) => ({ role: text(entry.role), email: text(entry.email), status: text(entry.status), at: isoTime(entry.completed_at) ?? isoTime(entry.opened_at) }));
        return { ok: true, value: { status, completedAt: isoTime(data.completed_at), signers } };
      }),

    listDocuments: (submissionId) =>
      withId(submissionId, async () => {
        const answer = await api("GET", `/submissions/${submissionId}/documents`);
        if (!answer.ok) return answer;
        const listed = isRecord(answer.value) ? answer.value.documents : undefined;
        if (!Array.isArray(listed)) return unexpected("documents");
        const documents: { url: string; name: string | null }[] = [];
        for (const entry of listed) {
          const url = isRecord(entry) ? webLink(entry.url) : null;
          if (url === null) return unexpected("document");
          documents.push({ url, name: text((entry as Record<string, unknown>).name) });
        }
        return { ok: true, value: documents };
      }),

    async downloadDocument(url) {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        return fail({ kind: "refused-url" });
      }
      if (target.origin !== origin || target.username || target.password) return fail({ kind: "refused-url" });
      const sent = await send(target, { method: "GET", headers: { Accept: "application/pdf", "User-Agent": USER_AGENT } });
      if (!sent.ok) return sent;
      const failed = failureOf(sent.response.status);
      if (failed) {
        await sent.response.body?.cancel().catch(() => {});
        return fail(failed);
      }
      const read = await readBounded(sent.response, MAX_PDF_BYTES);
      if (!read.ok) return read.error === "size" ? unexpected("size") : interrupted(read.cause);
      const bytes = read.bytes;
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") return unexpected("not a PDF");
      return { ok: true, value: bytes };
    },
  };
}

/** The client for the environment, or `not-configured` when either variable is missing or the URL is not a plain http(s) URL. */
export function docusealFromEnv(env: Record<string, string | undefined>, options: Partial<DocusealConfig> = {}): DocusealResult<DocusealClient> {
  const url = parseBase(env.DOCUSEAL_URL);
  const secret = env.DOCUSEAL_API_TOKEN?.trim();
  if (url === null || !secret) return fail({ kind: "not-configured" });
  return { ok: true, value: createDocusealClient({ ...options, url: url.href, token: secret }) };
}

/** True when both variables are present and usable; the pages use it to say signing is not set up. */
export const docusealConfigured = (env: Record<string, string | undefined> = process.env): boolean => docusealFromEnv(env).ok;
