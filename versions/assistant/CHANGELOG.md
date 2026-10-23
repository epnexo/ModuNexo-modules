# assistant

## 0.1.1 - 2026-10-23

- Reports to the dashboard: the replies of the last 24 hours and the conversations it stopped, and alerts for replies that failed and for the assistant being switched off. Needs a platform with SDK 0.1.1 or later (the optional `dashboard` field of the manifest).
- No migration; nothing else changed.

## 0.1.0 - 2026-10-23

- First release. Answers customers' messages by itself with a language model (OpenAI-compatible, so a local server or a paid
  provider), through the inbox. Off until switched on.
- Triggered by the inbox event `inbox.message.received`; waits a few seconds to answer a burst once, answers only the newest customer
  message and never one older than 15 minutes; one reply per customer message.
- Stops by itself when a person writes in the conversation, when the model asks for a person (`[[HANDOFF]]`) or at an hourly limit;
  a conversation can also be stopped and resumed by hand on `/assistant`.
- Pages `/assistant` and `/assistant/settings`; permissions `assistant.read` and `assistant.write`; reads the inbox through the
  read-only channel and sends through the inbox's service API.
