import { getDb } from "@modunexo/sdk";

type Heartbeat = { hostName?: unknown; version?: unknown; capabilities?: unknown; payloadShape?: unknown };

const text = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const SENSITIVE_FIELD = /(token|secret|password|certificate|address|email|phone)/i;

const payloadShape = (value: unknown): Record<string, string> | null => {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([key, kind]) => SENSITIVE_FIELD.test(key) || !/^[a-z][a-zA-Z0-9_]{0,63}$/.test(key) || !["number", "boolean", "string"].includes(String(kind)))) return null;
  return Object.fromEntries(entries) as Record<string, string>;
};

export async function POST(request: Request): Promise<Response> {
  let body: Heartbeat;
  try { body = await request.json() as Heartbeat; } catch { return Response.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const hostName = text(body.hostName);
  const version = text(body.version);
  if (!hostName || !version) return Response.json({ error: "hostName and version are required." }, { status: 400 });
  const shape = payloadShape(body.payloadShape);
  if (!shape) return Response.json({ error: "payloadShape contains a sensitive field." }, { status: 400 });
  await getDb("observability").query(
    `insert into collectors (host_name, version, capabilities, payload_shape, last_seen_at, updated_at)
     values ($1, $2, $3, $4, now(), now())
     on conflict (host_name) do update set version = excluded.version, capabilities = excluded.capabilities, payload_shape = excluded.payload_shape, last_seen_at = now(), updated_at = now()`,
    [hostName, version, JSON.stringify(Array.isArray(body.capabilities) ? body.capabilities : []), JSON.stringify(shape)],
  );
  return Response.json({ status: "connected" });
}
