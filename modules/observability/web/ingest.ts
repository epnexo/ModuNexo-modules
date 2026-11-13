import { getDb } from "@modunexo/sdk";

type Ingest = { hostName?: unknown; collectedAt?: unknown; metrics?: unknown };

const metricsOf = (value: unknown): Record<string, number> | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([key, metric]) => !/^[a-z][a-zA-Z0-9_]{0,63}$/.test(key) || typeof metric !== "number" || !Number.isFinite(metric))) return null;
  return Object.fromEntries(entries) as Record<string, number>;
};

export async function POST(request: Request): Promise<Response> {
  let body: Ingest;
  try { body = await request.json() as Ingest; } catch { return Response.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const hostName = typeof body.hostName === "string" ? body.hostName.trim() : "";
  const collectedAt = typeof body.collectedAt === "string" ? new Date(body.collectedAt) : new Date("");
  const metrics = metricsOf(body.metrics);
  if (!hostName || Number.isNaN(collectedAt.getTime()) || !metrics) return Response.json({ error: "hostName, collectedAt, and numeric metrics are required." }, { status: 400 });
  const db = getDb("observability");
  const collector = await db.query<{ id: number }>("select id from collectors where host_name = $1", [hostName]);
  if (!collector.rows[0]) return Response.json({ error: "collector_not_registered" }, { status: 404 });
  await db.query("insert into samples (collector_id, collected_at, metrics) values ($1, $2, $3)", [collector.rows[0].id, collectedAt, JSON.stringify(metrics)]);
  return Response.json({ status: "accepted" }, { status: 202 });
}
