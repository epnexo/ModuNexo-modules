# assistant

## 0.1.0 - 2026-10-23

- First release. Answers customers' messages by itself with a language model (OpenAI-compatible, so a local server or a paid
  provider), through the inbox. Off until switched on.
- Triggered by the inbox event `inbox.message.received`; waits a few seconds to answer a burst once, answers only the newest customer
  message and never one older than 15 minutes; one reply per customer message.
- Stops by itself when a person writes in the conversation, when the model asks for a person (`[[HANDOFF]]`) or at an hourly limit;
  a conversation can also be stopped and resumed by hand on `/assistant`.
- Pages `/assistant` and `/assistant/settings`; permissions `assistant.read` and `assistant.write`; reads the inbox through the
  read-only channel and sends through the inbox's service API.
