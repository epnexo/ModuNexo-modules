import type { Platform } from "./containers.ts";
import type { ContainerRow } from "./queries.ts";

export const STATE_FILTERS = ["live", "running", "problems", "gone"] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];

export interface ContainerFilters {
  host: string | null;
  state: StateFilter;
  q: string;
}

export interface ProjectGroup {
  name: string;
  rows: ContainerRow[];
  problems: number;
}

export interface HostGroup {
  hostName: string;
  platforms: Platform[];
  total: number;
  running: number;
  problems: number;
  projects: ProjectGroup[];
}

const single = (value: string | string[] | undefined): string | null => (typeof value === "string" ? value : null);

/** The filters in a page's query string; anything unknown falls back to no filter. */
export function parseContainerFilters(params: Record<string, string | string[] | undefined>): ContainerFilters {
  const host = single(params.host)?.trim() ?? "";
  const state = single(params.state);
  return { host: host === "" ? null : host, state: STATE_FILTERS.find((candidate) => candidate === state) ?? "live", q: single(params.q)?.trim() ?? "" };
}

const isProblem = (row: ContainerRow): boolean => !row.gone && row.state !== "running";

/** Live containers by default; "gone" shows the ones the platform stopped listing. */
export function filterContainers(rows: ContainerRow[], filters: ContainerFilters): ContainerRow[] {
  const needle = filters.q.toLowerCase();
  return rows.filter((row) => {
    if (filters.host !== null && row.hostName !== filters.host) return false;
    if (filters.state === "gone" ? !row.gone : row.gone) return false;
    if (filters.state === "running" && row.state !== "running") return false;
    if (filters.state === "problems" && !isProblem(row)) return false;
    return needle === "" || [row.name, row.project, row.image, row.service, row.domain].some((field) => field.toLowerCase().includes(needle));
  });
}

/** Hosts by name, each with its projects (those with problems first, then by name, no project last). */
export function groupByHost(rows: ContainerRow[]): HostGroup[] {
  const hosts = new Map<string, ContainerRow[]>();
  for (const row of rows) hosts.set(row.hostName, [...(hosts.get(row.hostName) ?? []), row]);
  return [...hosts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hostName, hostRows]) => {
    const projects = [...new Set(hostRows.map((row) => row.project))].map((name) => {
      const inProject = hostRows.filter((row) => row.project === name);
      return { name, rows: inProject, problems: inProject.filter(isProblem).length };
    }).sort((a, b) => (a.name === "" ? 1 : b.name === "" ? -1 : Number(b.problems > 0) - Number(a.problems > 0) || a.name.localeCompare(b.name)));
    return { hostName, platforms: [...new Set(hostRows.map((row) => row.platform))], total: hostRows.length, running: hostRows.filter((row) => row.state === "running" && !row.gone).length, problems: hostRows.filter(isProblem).length, projects };
  });
}

/** A link to the containers page with some filters changed; defaults are left out of the address. */
export function containerHref(filters: ContainerFilters, patch: Partial<ContainerFilters>): string {
  const next = { ...filters, ...patch };
  const query = new URLSearchParams();
  if (next.host !== null) query.set("host", next.host);
  if (next.state !== "live") query.set("state", next.state);
  if (next.q !== "") query.set("q", next.q);
  const text = query.toString();
  return `/observability/containers${text === "" ? "" : `?${text}`}`;
}
