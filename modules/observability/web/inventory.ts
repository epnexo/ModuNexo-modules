import { getDb } from "@modunexo/sdk";
import { applyInventory, parseInventory } from "../lib/guests.ts";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const inventory = parseInventory(body);
  if (inventory === null) return Response.json({ error: "hostName, collectedAt and a list of valid guests are required." }, { status: 400 });
  const collector = await getDb("observability").query<{ id: number }>("select id from collectors where host_name = $1", [inventory.hostName]);
  if (!collector.rows[0]) return Response.json({ error: "collector_not_registered" }, { status: 404 });
  await applyInventory(collector.rows[0].id, inventory.collectedAt, inventory.guests);
  return Response.json({ status: "accepted" }, { status: 202 });
}
