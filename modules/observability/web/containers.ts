import { getDb } from "@modunexo/sdk";
import { applyContainers, parseContainers } from "../lib/containers.ts";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const snapshot = parseContainers(body);
  if (snapshot === null) return Response.json({ error: "hostName, collectedAt and a list of valid containers are required." }, { status: 400 });
  const collector = await getDb("observability").query<{ id: number }>("select id from collectors where host_name = $1", [snapshot.hostName]);
  if (!collector.rows[0]) return Response.json({ error: "collector_not_registered" }, { status: 404 });
  await applyContainers(collector.rows[0].id, snapshot.collectedAt, snapshot.containers);
  return Response.json({ status: "accepted" }, { status: 202 });
}
