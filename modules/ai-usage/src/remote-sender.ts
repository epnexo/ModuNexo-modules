import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ActivityItem, Collector, SessionRecord, UsageRecord } from "./collector.ts";
import { sourceKey, type FailedFile } from "./ingest.ts";

const MAX_ENTRIES = 2000;
const REQUEST_TIMEOUT_MS = 30_000;
const FAILED_ID_LENGTH = 12;
export const INGEST_PATH = "/svc/ai-usage/ingest";

interface FileState {
  size: number;
  mtimeMs: number;
  offset: number;
  parserState: unknown;
}

/** What the sender remembers between runs: how far each log file was read. Keys are path hashes, never paths. */
type SenderState = Record<string, Record<string, FileState>>;

export interface SendReport {
  tool: string;
  filesScanned: number;
  filesSkipped: number;
  filesFailed: number;
  failedFiles: FailedFile[];
  sessionsInserted: number;
  eventsInserted: number;
  tokensInserted: number;
}

export interface SendOptions {
  /** The platform's base address, for example `https://modunexo.example.com`. */
  url: string;
  token: string;
  stateFile: string;
  fetch?: typeof fetch;
}

interface Part {
  sessions: SessionRecord[];
  usage: UsageRecord[];
  activity: ActivityItem[];
}

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * Splits what one file produced into requests the endpoint accepts: each carries at most MAX_ENTRIES of a kind, and
 * the sessions its entries refer to, because the endpoint refuses a usage entry whose session is not in the request.
 */
export function toParts(sessions: SessionRecord[], usage: UsageRecord[], activity: ActivityItem[]): Part[] {
  const byId = new Map(sessions.map((s) => [s.externalId, s]));
  const used = new Set<string>();
  const withSessions = (refs: Array<string | null>, rest: Omit<Part, "sessions">): Part => {
    const found = [...new Set(refs.filter((id): id is string => id !== null))].flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    for (const session of found) used.add(session.externalId);
    return { sessions: found, ...rest };
  };
  const parts: Part[] = [
    ...chunks(usage, MAX_ENTRIES).map((u) => withSessions(u.map((e) => e.sessionExternalId), { usage: u, activity: [] })),
    ...chunks(activity, MAX_ENTRIES).map((a) => withSessions(a.map((i) => i.sessionExternalId), { usage: [], activity: a })),
  ];
  for (const rest of chunks(sessions.filter((s) => !used.has(s.externalId)), MAX_ENTRIES)) parts.push({ sessions: rest, usage: [], activity: [] });
  return parts;
}

function loadState(file: string): SenderState {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SenderState;
  } catch {
    return {};
  }
}

function saveState(file: string, state: SenderState): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  renameSync(temp, file);
}

/**
 * Runs the collectors and posts what they find to the platform. Like the local ingestor it is safe to repeat: the
 * endpoint stores by natural key, and a file is read again only when it changed. A file is marked as read only after
 * every request for it was accepted, so a failure sends it again next run. A file that fails does not stop the run.
 */
export async function send(collectors: Collector[], options: SendOptions): Promise<SendReport[]> {
  const post = options.fetch ?? fetch;
  const endpoint = new URL(INGEST_PATH, options.url).toString();
  const state = loadState(options.stateFile);
  const reports: SendReport[] = [];

  for (const collector of collectors) {
    const known = (state[collector.toolId] ??= {});
    const report: SendReport = { tool: collector.toolId, filesScanned: 0, filesSkipped: 0, filesFailed: 0, failedFiles: [], sessionsInserted: 0, eventsInserted: 0, tokensInserted: 0 };
    for (const file of await collector.discover()) {
      report.filesScanned++;
      const key = sourceKey(file.path);
      const previous = known[key];
      if (previous && previous.size === file.size && previous.mtimeMs === file.mtimeMs) {
        report.filesSkipped++;
        continue;
      }
      try {
        const resumable = previous !== undefined && file.size >= previous.offset;
        const parsed = await collector.parse(file, resumable ? { offset: previous.offset, state: previous.parserState } : { offset: 0, state: null });
        for (const part of toParts(parsed.sessions, parsed.usage, parsed.activity ?? [])) {
          const response = await post(endpoint, {
            method: "POST",
            headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
            body: JSON.stringify({ tool: { slug: collector.toolId, name: collector.toolName }, ...part }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (!response.ok) throw Object.assign(new Error(`the platform answered ${response.status}`), { code: `HTTP_${response.status}` });
          const added = (await response.json()) as { sessionsInserted: number; eventsInserted: number; tokensInserted: number };
          report.sessionsInserted += added.sessionsInserted;
          report.eventsInserted += added.eventsInserted;
          report.tokensInserted += added.tokensInserted;
        }
        known[key] = { size: file.size, mtimeMs: file.mtimeMs, offset: parsed.offset, parserState: parsed.state };
        saveState(options.stateFile, state);
      } catch (error) {
        // Only a code or class name is kept: messages can contain paths or addresses.
        report.filesFailed++;
        report.failedFiles.push({ id: `${collector.toolId}:${key.slice(0, FAILED_ID_LENGTH)}`, reason: (error as { code?: string }).code ?? (error as Error).name ?? "Error" });
      }
    }
    reports.push(report);
  }
  return reports;
}
