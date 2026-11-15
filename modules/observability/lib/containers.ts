import { getDb } from "@modunexo/sdk";

export const PLATFORMS = ["dokploy", "coolify", "docker"] as const;
export const CONTAINER_STATES = ["running", "exited", "restarting", "paused", "created", "dead", "removing"] as const;
export type Platform = (typeof PLATFORMS)[number];
export type ContainerState = (typeof CONTAINER_STATES)[number];

/** What a collector reports about one Docker container at one moment. */
export interface ContainerInput {
  name: string;
  platform: Platform;
  project: string;
  environment: string;
  service: string;
  image: string;
  state: ContainerState;
  restarts: number;
  startedAt: Date | undefined;
  domain: string;
}

export interface ContainerSnapshot {
  hostName: string;
  collectedAt: Date;
  containers: ContainerInput[];
}

const MAX_CONTAINERS = 1000;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** An optional short text field: absent is empty, anything but a string within the limit is invalid. */
const text = (value: unknown): string | null => (value === undefined ? "" : typeof value === "string" && value.length <= 300 ? value.trim() : null);

function parseContainer(value: unknown): ContainerInput | null {
  if (!isRecord(value)) return null;
  const { name, platform, state, restarts, startedAt } = value;
  if (typeof name !== "string" || name.trim() === "" || name.length > 300) return null;
  if (!PLATFORMS.includes(platform as Platform) || !CONTAINER_STATES.includes(state as ContainerState)) return null;
  if (restarts !== undefined && (typeof restarts !== "number" || !Number.isInteger(restarts) || restarts < 0)) return null;
  let started: Date | undefined;
  if (startedAt !== undefined) {
    started = typeof startedAt === "string" ? new Date(startedAt) : new Date("");
    if (Number.isNaN(started.getTime())) return null;
  }
  const [project, environment, service, image, domain] = [text(value.project), text(value.environment), text(value.service), text(value.image), text(value.domain)];
  if (project === null || environment === null || service === null || image === null || domain === null) return null;
  return { name: name.trim(), platform: platform as Platform, project, environment, service, image, state: state as ContainerState, restarts: restarts ?? 0, startedAt: started, domain };
}

/** The snapshot in a request body, or null when anything in it is invalid (nothing is half-accepted). An empty list is valid: nothing is running any more. */
export function parseContainers(body: unknown): ContainerSnapshot | null {
  if (!isRecord(body)) return null;
  const hostName = typeof body.hostName === "string" ? body.hostName.trim() : "";
  const collectedAt = typeof body.collectedAt === "string" ? new Date(body.collectedAt) : new Date("");
  if (hostName === "" || Number.isNaN(collectedAt.getTime())) return null;
  if (!Array.isArray(body.containers) || body.containers.length > MAX_CONTAINERS) return null;
  const containers: ContainerInput[] = [];
  for (const raw of body.containers) {
    const container = parseContainer(raw);
    if (container === null || containers.some((other) => other.name === container.name)) return null;
    containers.push(container);
  }
  return { hostName, collectedAt, containers };
}

/**
 * Records a collector's full container list: creates or updates each container, and marks as gone the ones it knew
 * that are no longer listed (they come back when listed again). Other collectors' containers are never touched.
 */
export async function applyContainers(collectorId: number, collectedAt: Date, containers: ContainerInput[]): Promise<void> {
  const db = getDb("observability");
  for (const box of containers) {
    await db.query(
      `insert into containers (collector_id, name, platform, project, environment, service, image, state, restarts, started_at, domain, first_seen_at, last_seen_at, state_since)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $12)
       on conflict (collector_id, name) do update set
         state_since = case when containers.state = excluded.state and containers.gone_at is null then containers.state_since else excluded.last_seen_at end,
         platform = excluded.platform, project = excluded.project, environment = excluded.environment, service = excluded.service, image = excluded.image,
         state = excluded.state, restarts = excluded.restarts, started_at = excluded.started_at, domain = excluded.domain,
         last_seen_at = greatest(containers.last_seen_at, excluded.last_seen_at), gone_at = null`,
      [collectorId, box.name, box.platform, box.project, box.environment, box.service, box.image, box.state, box.restarts, box.startedAt ?? null, box.domain, collectedAt],
    );
  }
  await db.query("update containers set gone_at = $2 where collector_id = $1 and gone_at is null and not (name = any($3::text[]))", [collectorId, collectedAt, containers.map((box) => box.name)]);
}
