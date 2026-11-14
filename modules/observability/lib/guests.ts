import { getDb } from "@modunexo/sdk";

/** What a collector reports about one guest (VM or container) of a hypervisor at one moment. */
export interface GuestInput {
  vmid: number;
  name: string;
  kind: "qemu" | "lxc";
  node: string;
  running: boolean;
  /** Seconds since the guest booted, when running and known. */
  uptimeSeconds: number | undefined;
  /** Whether a backup covers the guest, when the collector knows. */
  backedUp: boolean | undefined;
  metrics: Record<string, number>;
}

export interface Inventory {
  hostName: string;
  collectedAt: Date;
  guests: GuestInput[];
}

const MAX_GUESTS = 500;
/** A boot time this much later than the open session's means the guest restarted between two polls. */
const RESTART_TOLERANCE_MS = 120_000;
const METRIC_KEY = /^[a-z][a-zA-Z0-9_]{0,63}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function parseGuest(value: unknown): GuestInput | null {
  if (!isRecord(value)) return null;
  const { vmid, name, kind, node, running, uptimeSeconds, backedUp, metrics } = value;
  if (typeof vmid !== "number" || !Number.isInteger(vmid) || vmid < 0) return null;
  if (typeof name !== "string" || name.trim() === "" || name.length > 200) return null;
  if (kind !== "qemu" && kind !== "lxc") return null;
  if (node !== undefined && (typeof node !== "string" || node.length > 200)) return null;
  if (typeof running !== "boolean") return null;
  if (uptimeSeconds !== undefined && (typeof uptimeSeconds !== "number" || !Number.isFinite(uptimeSeconds) || uptimeSeconds < 0)) return null;
  if (backedUp !== undefined && typeof backedUp !== "boolean") return null;
  let clean: Record<string, number> = {};
  if (metrics !== undefined) {
    if (!isRecord(metrics)) return null;
    const entries = Object.entries(metrics);
    if (entries.some(([key, metric]) => !METRIC_KEY.test(key) || typeof metric !== "number" || !Number.isFinite(metric))) return null;
    clean = Object.fromEntries(entries) as Record<string, number>;
  }
  return { vmid, name: name.trim(), kind, node: node ?? "", running, uptimeSeconds, backedUp, metrics: clean };
}

/** The inventory in a request body, or null when anything in it is invalid (nothing is half-accepted). */
export function parseInventory(body: unknown): Inventory | null {
  if (!isRecord(body)) return null;
  const hostName = typeof body.hostName === "string" ? body.hostName.trim() : "";
  const collectedAt = typeof body.collectedAt === "string" ? new Date(body.collectedAt) : new Date("");
  if (hostName === "" || Number.isNaN(collectedAt.getTime())) return null;
  if (!Array.isArray(body.guests) || body.guests.length === 0 || body.guests.length > MAX_GUESTS) return null;
  const guests: GuestInput[] = [];
  for (const raw of body.guests) {
    const guest = parseGuest(raw);
    if (guest === null || guests.some((other) => other.vmid === guest.vmid)) return null;
    guests.push(guest);
  }
  return { hostName, collectedAt, guests };
}

/**
 * Records what a collector saw: creates or updates each guest, keeps one open session per running guest (started at its
 * boot time, closed when it stops or when a lower uptime shows it restarted), remembers when it was last up and stores
 * its metrics as a sample.
 */
export async function applyInventory(collectorId: number, collectedAt: Date, guests: GuestInput[]): Promise<void> {
  const db = getDb("observability");
  for (const guest of guests) {
    const upserted = await db.query<{ id: number }>(
      `insert into guests (collector_id, vmid, name, kind, node, running, backed_up, first_seen_at, last_seen_at, last_up_at)
       values ($1, $2, $3, $4, $5, $6::boolean, $7, $8, $8, case when $6::boolean then $8::timestamptz end)
       on conflict (collector_id, vmid) do update set
         name = excluded.name, kind = excluded.kind, node = excluded.node, running = excluded.running,
         backed_up = coalesce(excluded.backed_up, guests.backed_up),
         last_seen_at = greatest(guests.last_seen_at, excluded.last_seen_at),
         last_up_at = case when excluded.running then greatest(guests.last_up_at, excluded.last_up_at) else guests.last_up_at end
       returning id`,
      [collectorId, guest.vmid, guest.name, guest.kind, guest.node, guest.running, guest.backedUp ?? null, collectedAt],
    );
    const guestId = upserted.rows[0]!.id;
    if (guest.running) {
      const startedAt = guest.uptimeSeconds === undefined ? collectedAt : new Date(collectedAt.getTime() - guest.uptimeSeconds * 1000);
      const open = await db.query<{ id: number; started_at: Date }>("select id, started_at from guest_sessions where guest_id = $1 and ended_at is null", [guestId]);
      const current = open.rows[0];
      const restarted = current !== undefined && guest.uptimeSeconds !== undefined && startedAt.getTime() > current.started_at.getTime() + RESTART_TOLERANCE_MS;
      if (restarted) await db.query("update guest_sessions set ended_at = greatest(started_at, $2) where id = $1", [current.id, startedAt]);
      if (current === undefined || restarted) await db.query("insert into guest_sessions (guest_id, started_at) values ($1, $2)", [guestId, startedAt]);
      if (Object.keys(guest.metrics).length > 0) await db.query("insert into guest_samples (guest_id, collected_at, metrics) values ($1, $2, $3)", [guestId, collectedAt, JSON.stringify(guest.metrics)]);
    } else {
      await db.query("update guest_sessions set ended_at = greatest(started_at, $2) where guest_id = $1 and ended_at is null", [guestId, collectedAt]);
    }
  }
}
