import { LlmError, chat, enqueueJob, getDb } from "@modunexo/sdk";
import { loadConfig } from "./config.ts";
import { inboxTarget, latestInbound, recentMessages, sendReply, sentIds } from "./inbox.ts";
import { buildMessages, readReply } from "./prompt.ts";
import { pauseConversation, pausedReason, resumedBaseline } from "./state.ts";

export type Outcome = "disabled" | "paused" | "superseded" | "stale" | "answered_already" | "busy" | "human" | "limit" | "answered" | "handoff" | "nothing_to_say" | "refused";

const MINUTE = 60_000;
/** A customer message older than this is not answered: the person has moved on. */
const STALE_MS = 15 * MINUTE;
/** A reply claimed longer ago than this and never finished belongs to a job that died. */
const CLAIM_TTL_MS = 5 * MINUTE;
const HOUR_MS = 60 * MINUTE;
/** How many times one job may start over for a customer who keeps writing while it answers. */
const MAX_ROUNDS = 3;

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

/** Whether someone other than the assistant has written in the conversation since it was last resumed (or ever, if it never was). */
async function personWrote(conversationId: number): Promise<boolean> {
  const db = getDb("assistant");
  const ours = new Set((await db.query<{ message_id: string }>("select message_id from replies where conversation_id = $1 and message_id is not null", [conversationId])).rows.map((r) => Number(r.message_id)));
  const from = (await resumedBaseline(conversationId))?.afterMessageId ?? 0;
  return (await sentIds(conversationId)).some((id) => id > from && !ours.has(id));
}

/**
 * The last round cannot start over, so a customer message that arrived meanwhile gets a job of its own: the jobs the inbox
 * queued for it found this one busy and left. A failure to queue is not reported: the reply it follows is already sent.
 */
async function queueFollowUp(conversationId: number, messageId: number): Promise<void> {
  try {
    await enqueueJob("assistant", "answer", { event: { payload: { conversationId, messageId } } }, { dedupeKey: `answer:${conversationId}:${messageId}` });
  } catch {
    // Nothing to do: the next message of the conversation wakes the assistant again.
  }
}

type Step = { kind: "done"; outcome: Outcome } | { kind: "again"; newer: number };
const done = (outcome: Outcome): Step => ({ kind: "done", outcome });

/**
 * Answers the customer's latest message by itself, or says why it did not. In order: it must be switched on and the
 * conversation not stopped; it waits a moment so a burst is answered once; only the newest customer message is answered,
 * and only if it is recent; the right to answer is claimed (so two jobs never both answer); a person having written, or
 * the hourly limit, stops it for that conversation; then the model is asked, everything is checked again, and the reply
 * goes through the inbox. If the customer wrote again while it worked, it starts over for the newest message (up to
 * three rounds), because the jobs of the newer messages found it busy and left the answering to it.
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

  let messageId = input.messageId;
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const step = await answerOnce({ input, now, sleep, messageId, drain: round > 1, canStartOver: round < MAX_ROUNDS });
    if (step.kind === "done") return step.outcome;
    messageId = step.newer;
  }
  return "answered"; // not reached: the last round never starts over
}

async function answerOnce(ctx: { input: AnswerInput; now: () => Date; sleep: NonNullable<AnswerInput["sleep"]>; messageId: number; drain: boolean; canStartOver: boolean }): Promise<Step> {
  const { input, now } = ctx;
  const { conversationId } = input;
  const config = await loadConfig();
  if (!config.enabled) return done("disabled");
  if ((await pausedReason(conversationId)) !== null) return done("paused");

  const last = await latestInbound(conversationId);
  if (last === null) return done("superseded");
  // A job woken by an older message leaves the newer one to its own job; a job starting over is that job's replacement.
  if (last.id > ctx.messageId && !ctx.drain) return done("superseded");
  if (now().getTime() - last.createdAt.getTime() > STALE_MS) return done("stale");
  if (ctx.drain) {
    const quiet = config.waitSeconds * 1000 - (now().getTime() - last.createdAt.getTime());
    if (quiet > 0) await ctx.sleep(quiet, input.signal);
  }

  const target = await inboxTarget(); // before the model: an answer that cannot be sent is not worth paying for
  const claimed = await claim(conversationId, last.id, now());
  if (claimed === null) {
    const mine = await getDb("assistant").query("select 1 from replies where conversation_id = $1 and in_reply_to = $2 and status in ('sending', 'sent')", [conversationId, last.id]);
    return done(mine.rows.length > 0 ? "answered_already" : "busy");
  }

  try {
    const db = getDb("assistant");
    if (await personWrote(conversationId)) {
      await pauseConversation(conversationId, "human");
      await release(claimed, "human", now());
      return done("human");
    }

    const baseline = await resumedBaseline(conversationId);
    const windowStart = Math.max(now().getTime() - HOUR_MS, baseline?.at.getTime() ?? 0);
    const recent = await db.query<{ n: number }>("select count(*)::int as n from replies where conversation_id = $1 and status = 'sent' and created_at > $2", [conversationId, new Date(windowStart)]);
    if (recent.rows[0]!.n >= config.maxRepliesPerHour) {
      await pauseConversation(conversationId, "limit");
      await release(claimed, "limit", now());
      return done("limit");
    }

    let answer;
    try {
      answer = await chat("assistant", { messages: buildMessages(config.instructions, await recentMessages(conversationId, config.historyMessages)), temperature: 0.3, maxTokens: 400, signal: input.signal });
    } catch (error) {
      const code = error instanceof LlmError ? error.code : "unknown";
      await release(claimed, `model: ${code}`, now());
      throw new Error(`The model could not answer (${code}).`);
    }

    // Things change while the model thinks: look again before anything is sent.
    if (!(await loadConfig()).enabled) {
      await release(claimed, "switched off", now());
      return done("disabled");
    }
    if ((await pausedReason(conversationId)) !== null) {
      await release(claimed, "stopped", now());
      return done("paused");
    }
    if (await personWrote(conversationId)) {
      await pauseConversation(conversationId, "human");
      await release(claimed, "human", now());
      return done("human");
    }
    const newest = await latestInbound(conversationId);
    if (newest !== null && newest.id > last.id && ctx.canStartOver) {
      await release(claimed, "superseded", now()); // the customer wrote again: this answer is about an older message
      return { kind: "again", newer: newest.id };
    }

    const { text, handoff } = readReply(answer.content);
    if (text === "") {
      if (handoff) await pauseConversation(conversationId, "handoff");
      await release(claimed, handoff ? "handoff" : "empty answer", now());
      return done(handoff ? "handoff" : "nothing_to_say");
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
      return done("refused");
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
      return done("handoff");
    }
    // After the reply is recorded, so a job that found the claim busy is covered: anything it left to us is seen here.
    const after = await latestInbound(conversationId);
    if (after !== null && after.id > last.id) {
      if (ctx.canStartOver) return { kind: "again", newer: after.id };
      await queueFollowUp(conversationId, after.id);
    }
    return done("answered");
  } catch (error) {
    await release(claimed, "error", now()); // a no-op when it was released above
    throw error;
  }
}
