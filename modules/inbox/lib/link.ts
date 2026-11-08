import { enqueueJob, getSetting } from "@modunexo/sdk";

export const LINK_ATTEMPTS = 5;

export type ContactsConfig = { base: string; token: string };

/** The address of the contacts module and the token to call it with; null while either is missing, which keeps the link off. */
export async function contactsConfig(): Promise<ContactsConfig | null> {
  const [url, token] = await Promise.all([getSetting("inbox", "contacts_url"), getSetting("inbox", "contacts_token")]);
  const base = typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";
  const secret = typeof token === "string" ? token.trim() : "";
  return base === "" || secret === "" ? null : { base, token: secret };
}

/**
 * Asks for a conversation to be linked to its contact. Never fails the caller: the message is already stored, and the next
 * message of the conversation asks again. One request waits at a time per conversation (the job's dedupe key).
 */
export async function requestLink(conversationId: number): Promise<void> {
  try {
    if ((await contactsConfig()) === null) return;
    await enqueueJob("inbox", "link_contact", { conversationId }, { dedupeKey: `link:${conversationId}` });
  } catch {
    // Nothing to report: the webhook's answer does not depend on the link.
  }
}
