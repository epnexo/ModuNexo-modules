import { LlmError, chat, getDb } from "@modunexo/sdk";
import { loadConfig } from "./config.ts";
import { inboxTarget, latestInbound, recentMessages, sendReply, sentIds } from "./inbox.ts";
import { buildMessages, readReply } from "./prompt.ts";
import { pauseConversation, pausedReason } from "./state.ts";

export type Outcome = "disabled" | "paused" | "superseded" | "stale" | "answered_already" | "human" | "limit" | "answered" | "handoff" | "nothing_to_say" | "refused";

const MINUTE = 60_000;
/** A customer message older than this is not answered: the person has moved on. */
const STALE_MS = 15 * MINUTE;
/** A reply claimed longer ago than this and never finished belongs to a job that died. */
const CLAIM_TTL_MS = 5 * MINUTE;
const HOUR_MS = 60 * MINUTE;

export type AnswerInput = {
  conversationId: number;
  /** The customer message that woke the job. */
  messageId: number;
  signal?: AbortSignal;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("The job was stopped."));
    }, { once: true });
  });

/** Takes the right to answer one customer message. Null when a reply for it, or any reply in this conversation, is already on its way or sent. */
async function claim(conversationId: number, inReplyTo: number, now: Date): Promise<number | null> {
  const db = getDb("assistant");
  await db.query("update replies set status = 'failed', error = 'abandoned', finished_at = $2 where status = 'sending' and created_at < $1", [new Date(now.getTime() - CLAIM_TTL_MS), now]);
  const made = await db.query<{ id: string }>("insert into replies (conversation_id, in_reply_to, status, created_at) values ($1, $2, 'sending', $3) on conflict do nothing returning id", [conversationId, inReplyTo, now]);
  return made.rows[0] === undefined ? null : Number(made.rows[0].id);
}

const release = (id: number, why: string, now: Date) => getDb("assistant").query("update replies set status = 'failed', error = $2, finished_at = $3 where id = $1 and status = 'sending'", [id, why, now]);

/**
 * Answers the customer's latest message by itself, or says why it did not. In order: it must be switched on and the
 * conversation not stopped; it waits a moment so a burst is answered once; only the newest customer message is answered,
 * and only if it is recent; the right to answer is claimed (so two jobs never both answer); a person having written, or
 * the hourly limit, stops it for that conversation; then the model is asked and the reply goes through the inbox.
 */
export async function answerMessage(input: AnswerInput): Promise<Outcome> {
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? defaultSleep;
  const { conversationId } = input;

  let config = await loadConfig();
  if (!config.enabled) return "disabled";
  if ((await pausedReason(conversationId)) !== null) return "paused";
  if (config.waitSeconds > 0) {
    await sleep(config.waitSeconds * 1000, input.signal);
    config = await loadConfig();
    if (!config.enabled) return "disabled";
    if ((await pausedReason(conversationId)) !== null) return "paused";
  }

  const last = await latestInbound(conversationId);
  if (last === null || last.id > input.messageId) return "superseded";
  if (now().getTime() - last.createdAt.getTime() > STALE_MS) return "stale";

  const target = await inboxTarget(); // before the model: an answer that cannot be sent is not worth paying for
  const claimed = await claim(conversationId, last.id, now());
  if (claimed === null) return "answered_already";

  try {
    const db = getDb("assistant");
    const ours = new Set((await db.query<{ message_id: string }>("select message_id from replies where conversation_id = $1 and message_id is not null", [conversationId])).rows.map((r) => Number(r.message_id)));
    if ((await sentIds(conversationId)).some((id) => !ours.has(id))) {
      await pauseConversation(conversationId, "human");
      await release(claimed, "human", now());
      return "human";
    }

    const sinceHour = new Date(now().getTime() - HOUR_MS);
    const recent = await db.query<{ n: number }>("select count(*)::int as n from replies where conversation_id = $1 and status = 'sent' and created_at > $2", [conversationId, sinceHour]);
    if (recent.rows[0]!.n >= config.maxRepliesPerHour) {
      await pauseConversation(conversationId, "limit");
      await release(claimed, "limit", now());
      return "limit";
    }

    let answer;
    try {
      answer = await chat("assistant", { messages: buildMessages(config.instructions, await recentMessages(conversationId, config.historyMessages)), temperature: 0.3, maxTokens: 400, signal: input.signal });
    } catch (error) {
      const code = error instanceof LlmError ? error.code : "unknown";
      await release(claimed, `model: ${code}`, now());
      throw new Error(`The model could not answer (${code}).`);
    }

    const { text, handoff } = readReply(answer.content);
    if (text === "") {
      if (handoff) await pauseConversation(conversationId, "handoff");
      await release(claimed, handoff ? "handoff" : "empty answer", now());
      return handoff ? "handoff" : "nothing_to_say";
    }

    let sent: number | null | "refused";
    try {
      sent = await sendReply(target, conversationId, text, input.signal);
    } catch (error) {
      await release(claimed, "send failed", now());
      throw error;
    }
    if (sent === "refused") {
      await release(claimed, "refused by the inbox", now());
      return "refused";
    }
    await db.query("update replies set status = 'sent', message_id = $2, model = $3, prompt_tokens = $4, completion_tokens = $5, finished_at = $6 where id = $1", [
      claimed,
      sent,
      answer.model,
      answer.usage?.promptTokens ?? null,
      answer.usage?.completionTokens ?? null,
      now(),
    ]);
    if (handoff) {
      await pauseConversation(conversationId, "handoff");
      return "handoff";
    }
    return "answered";
  } catch (error) {
    await release(claimed, "error", now()); // a no-op when it was released above
    throw error;
  }
}
