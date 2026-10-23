import { getDb, type JobContext } from "@modunexo/sdk";
import { contactsConfig } from "../lib/link.ts";

type Row = { channel: string; contact_ref: string; contact_name: string | null; contact_id: string | null };

/**
 * Links a conversation to its contact in the contacts module: looks the person up by their channel identity
 * (`<channel>:<reference>`), creates them when nobody holds it, and keeps the id. It always fails with a fixed phrase or
 * the HTTP status, never with the address, the token or what the service answered, so the retry and the Status screen
 * show nothing private.
 */
export default async function linkContact(ctx: JobContext): Promise<void> {
  const conversationId = (ctx.payload as { conversationId?: unknown } | null)?.conversationId;
  if (typeof conversationId !== "number" || !Number.isSafeInteger(conversationId)) return;
  const db = getDb("inbox");
  const found = await db.query<Row>("select channel, contact_ref, contact_name, contact_id from conversations where id = $1", [conversationId]);
  const row = found.rows[0];
  if (row === undefined || row.contact_id !== null) return;
  const config = await contactsConfig();
  if (config === null) return;

  let protocol: string;
  try {
    protocol = new URL(config.base).protocol;
  } catch {
    throw new Error("The contacts address is not a valid URL.");
  }
  if (protocol !== "http:" && protocol !== "https:") throw new Error("The contacts address must start with http:// or https://.");

  const identity = `${row.channel}:${row.contact_ref}`;
  const send = async (path: string, init: { method: string; body?: string }): Promise<Response> => {
    try {
      return await fetch(`${config.base}${path}`, { ...init, redirect: "error", signal: ctx.signal, headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" } });
    } catch {
      throw new Error("The contacts service could not be reached.");
    }
  };
  const idOf = async (response: Response): Promise<number> => {
    const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
    if (typeof body?.id !== "number" || !Number.isSafeInteger(body.id) || body.id < 1) throw new Error("The contacts service gave no contact id.");
    return body.id;
  };

  let contactId: number;
  const lookup = await send(`/svc/contacts/contact?identity=${encodeURIComponent(identity)}`, { method: "GET" });
  if (lookup.status === 200) {
    contactId = await idOf(lookup);
  } else if (lookup.status === 404) {
    const created = await send("/svc/contacts/contacts/create", { method: "POST", body: JSON.stringify({ name: row.contact_name ?? row.contact_ref, identity }) });
    if (created.status !== 201 && created.status !== 409) throw new Error(`The contacts service answered HTTP ${created.status}.`);
    contactId = await idOf(created);
  } else {
    throw new Error(`The contacts service answered HTTP ${lookup.status}.`);
  }
  await db.query("update conversations set contact_id = $1 where id = $2 and contact_id is null", [contactId, conversationId]);
}
