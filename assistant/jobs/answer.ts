import type { JobContext } from "@modunexo/sdk";
import { answerMessage } from "../lib/answer.ts";

/** Runs for each customer message the inbox announces (`inbox.message.received`). */
export default async function answer(ctx: JobContext): Promise<void> {
  const payload = (ctx.payload as { event?: { payload?: { conversationId?: unknown; messageId?: unknown } } } | null)?.event?.payload;
  const conversationId = payload?.conversationId;
  const messageId = payload?.messageId;
  if (typeof conversationId !== "number" || !Number.isSafeInteger(conversationId) || typeof messageId !== "number" || !Number.isSafeInteger(messageId)) return;
  await answerMessage({ conversationId, messageId, signal: ctx.signal });
}
