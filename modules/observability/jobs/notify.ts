import { getSetting, type JobContext } from "@modunexo/sdk";
import { deliver } from "../lib/webhook.ts";

type Delivered = { event?: { id?: unknown; type?: unknown; createdAt?: unknown; payload?: unknown } };

/**
 * Runs once for every `observability.alert` event and posts it to the webhook set in the module settings (for example
 * an n8n workflow). With no address set it does nothing. The platform retries a failed run, so a receiver that is down
 * for a while still gets the alert.
 */
export default async function notify(ctx: JobContext): Promise<void> {
  const event = (ctx.payload as Delivered | null)?.event;
  if (event === undefined || typeof event.payload !== "object" || event.payload === null) return;
  const url = await getSetting("observability", "alert_webhook_url");
  if (typeof url !== "string" || url.trim() === "") return;
  const secret = await getSetting("observability", "alert_webhook_secret");
  await deliver(url.trim(), typeof secret === "string" && secret !== "" ? secret : null, { id: event.id, type: event.type, createdAt: event.createdAt, ...event.payload }, AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]));
}
