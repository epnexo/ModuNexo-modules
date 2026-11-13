import { getDb } from "@modunexo/sdk";

type Event = { id?: unknown; occurredAt?: unknown; level?: unknown; unit?: unknown; message?: unknown };
type Payload = { hostName?: unknown; events?: unknown };

export async function POST(request: Request): Promise<Response> {
  let body: Payload;
  try { body = await request.json() as Payload; } catch { return Response.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const hostName = typeof body.hostName === "string" ? body.hostName.trim() : "";
  const events = Array.isArray(body.events) ? body.events : null;
  if (!hostName || events === null || events.length > 100) return Response.json({ error: "hostName and up to 100 events are required." }, { status: 400 });
  const db = getDb("observability");
  const collector = await db.query<{ id: number }>("select id from collectors where host_name = $1", [hostName]);
  if (!collector.rows[0]) return Response.json({ error: "collector_not_registered" }, { status: 404 });
  for (const event of events as Event[]) {
    const occurredAt = typeof event.occurredAt === "string" ? new Date(event.occurredAt) : new Date("");
    if (typeof event.id !== "string" || !/^[a-f0-9]{64}$/.test(event.id) || Number.isNaN(occurredAt.getTime()) || (event.level !== "warning" && event.level !== "error") || typeof event.unit !== "string" || event.unit.length > 120 || typeof event.message !== "string" || event.message.length > 500) return Response.json({ error: "Invalid event." }, { status: 400 });
    await db.query("insert into collector_events (collector_id, event_key, occurred_at, level, unit, message) values ($1, $2, $3, $4, $5, $6) on conflict (collector_id, event_key) do nothing", [collector.rows[0].id, event.id, occurredAt, event.level, event.unit, event.message]);
  }
  return Response.json({ status: "accepted" }, { status: 202 });
}
