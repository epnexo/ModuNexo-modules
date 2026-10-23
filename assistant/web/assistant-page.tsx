import { getSetting } from "@modunexo/sdk";
import { loadConfig } from "../lib/config.ts";
import { messageTexts, recentConversations, type ConversationLine } from "../lib/inbox.ts";
import { latestReplies } from "../lib/replies.ts";
import { listPaused, type PauseReason } from "../lib/state.ts";
import { BUTTON_QUIET, when } from "./ui.ts";

export const metadata = { title: "Assistant" };

const REASON: Record<PauseReason, string> = {
  human: "a person wrote in the conversation",
  handoff: "the model asked for a person",
  limit: "the hourly limit was reached",
  manual: "stopped by hand",
};

const label = (c: ConversationLine): string => c.contactName ?? c.contactRef;
const hostOf = (url: unknown): string | null => {
  if (typeof url !== "string" || url.trim() === "") return null;
  try {
    return new URL(url.trim()).host;
  } catch {
    return null;
  }
};
const missing = (value: unknown): boolean => typeof value !== "string" || value.trim() === "";

export default async function Page() {
  const [config, llmUrl, inboxUrl, inboxToken, conversations, paused, replies] = await Promise.all([
    loadConfig(),
    getSetting("assistant", "llm.url"),
    getSetting("assistant", "inbox_url"),
    getSetting("assistant", "inbox_token"),
    recentConversations(30),
    listPaused(),
    latestReplies(15),
  ]);
  const stopped = new Map(paused.map((p) => [p.conversationId, p]));
  const names = new Map(conversations.map((c) => [c.id, label(c)]));
  const texts = await messageTexts(replies.flatMap((r) => (r.messageId === null ? [] : [r.messageId])));
  const warnings = [missing(llmUrl) ? "The model endpoint is not set." : null, missing(inboxUrl) ? "The inbox address is not set." : null, missing(inboxToken) ? "The inbox token is not set." : null].filter((w): w is string => w !== null);
  const host = hostOf(llmUrl);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Assistant</h1>
        <a href="/assistant/settings" className="text-sm underline-offset-4 hover:underline">
          Settings
        </a>
      </div>

      <section aria-label="State" className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-sm">
        <p className="font-medium">{config.enabled ? "Switched on" : "Switched off"}</p>
        <p className="text-muted">
          {config.enabled
            ? `It answers customers' messages by itself.${host === null ? "" : ` Their messages are sent to the model at ${host}.`}`
            : "It answers nothing, and no message leaves the platform, until you switch it on in the settings."}
        </p>
        {warnings.map((warning) => (
          <p key={warning} role="note" className="rounded-md bg-warning-soft px-3 py-2">
            {warning} Set it in the platform&apos;s Settings screen.
          </p>
        ))}
      </section>

      <section aria-label="Conversations" className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold tracking-tight">Conversations</h2>
        {conversations.length === 0 ? (
          <p className="text-sm text-muted">No conversation yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            {conversations.map((c) => {
              const stop = stopped.get(c.id);
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                  <span className="flex flex-col">
                    <span className="font-medium">{label(c)}</span>
                    <span className="text-xs text-muted">
                      <time dateTime={c.lastMessageAt.toISOString()}>{when(c.lastMessageAt)}</time>
                    </span>
                  </span>
                  {stop === undefined ? (
                    <form method="post" action="/assistant/pause" className="flex items-center gap-2">
                      <span className="text-muted">Active</span>
                      <input type="hidden" name="conversationId" value={c.id} />
                      <button type="submit" className={BUTTON_QUIET}>
                        Pause
                      </button>
                    </form>
                  ) : (
                    <form method="post" action="/assistant/resume" className="flex items-center gap-2">
                      <span className="text-muted">{`Stopped: ${REASON[stop.reason]}`}</span>
                      <input type="hidden" name="conversationId" value={c.id} />
                      <button type="submit" className={BUTTON_QUIET}>
                        Resume
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="Latest replies" className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold tracking-tight">Latest replies</h2>
        {replies.length === 0 ? (
          <p className="text-sm text-muted">Nothing yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {replies.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 rounded-md border border-border bg-surface p-3 text-sm">
                <span className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                  <span>{names.get(r.conversationId) ?? `Conversation ${r.conversationId}`}</span>
                  <span>
                    <time dateTime={r.createdAt.toISOString()}>{when(r.createdAt)}</time>
                    {` · ${r.status}${r.model === null ? "" : ` · ${r.model}`}`}
                  </span>
                </span>
                {r.messageId !== null && texts.has(r.messageId) ? <span className="whitespace-pre-wrap break-words">{texts.get(r.messageId)}</span> : null}
                {r.error === null ? null : <span className="text-muted">{r.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
