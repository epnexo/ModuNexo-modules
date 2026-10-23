# assistant

Objective: a module `assistant` that answers customers' messages by itself, with a language model, through the inbox. Built here and installed as an archive, never inside the platform. Branch: feat/assistant-module. Delivery: single slice, merge and push only on the user's word. Test runner: `node --import tsx --test`.

## Specs

- S1. "que la IA conteste sola a los clientes". The route chosen is an integrated assistant (a module that uses the platform's language-model capability, OpenAI-compatible, so a local server or a paid provider both work), not an external service and not an MCP server.
- S2. Off by default. Nothing is answered, and nothing leaves the platform, until an administrator switches it on in `/assistant/settings`. [decision: the customers' messages go to a model provider]
- S3. Trigger: the event `inbox.message.received` (the module depends on `inbox` `^0.3.0`) queues a job `answer`. The job waits `wait_seconds` (0 to 60, default 5) so a burst of messages is answered once; if a newer customer message exists by then, it does nothing (the job of the newer one answers). It never answers a message older than 15 minutes.
- S4. It answers once per customer message: a reply is claimed before the model is asked, two replies are never in flight for one conversation, and a retry never sends a second reply for a message already answered.
- S5. The model gets the instructions the administrator wrote, fixed rules (reply in the customer's language, short, never invent prices, availability or promises, answer only with the marker `[[HANDOFF]]` when the customer asks for a person or it cannot help) and the last `history_messages` messages of the conversation (1 to 50, default 20), customer messages as the user and sent ones as the assistant.
- S6. It stops by itself and says why: `human` (a message was sent in the conversation that the assistant did not send), `handoff` (the model answered with the marker; any text around it is still sent), `limit` (`max_replies_per_hour` replies in the last hour, 1 to 100, default 10). A stopped conversation stays stopped until someone resumes it on `/assistant`; a person can also stop one by hand.
- S7. It reads the inbox through the platform's read-only channel and sends through `POST /svc/inbox/messages/send` with a service token (settings `inbox_url` and `inbox_token`, the token holding `messages.write`). It writes nothing in the inbox's tables.
- S8. A failing model or inbox makes the job retry (3 attempts) and the error shown is a code or a fixed phrase, never the address, the key, the token or what the provider said; a customer is never left with a half-sent reply.
- S9. Pages `/assistant` (the state of each recent conversation with Pause and Resume, the latest replies) and `/assistant/settings` (on or off, instructions up to 8000 characters, wait, history, limit); forms post to routes that check the origin is this site. Permissions `assistant.read` and `assistant.write`.

## Tasks

- [x] T1 (S2, S5, S6, S9) migration, settings of the module, conversation state, the prompt and the marker, with tests. inline.
- [x] T2 (S3, S4, S6, S7, S8) the job: the checks, the model, the send; with a fake model and the real inbox route behind a local server. inline.
- [x] T3 (S9) form routes, the two pages, the manifest. inline.
- T4 (S1-S9) README, changelog, pack, real install on an isolated worktree and database with a fake model; an independent verifier at the end (it replies to customers by itself).

## Log

- L1: "que la IA conteste sola a los clientes" (after the explanation of the three ways to connect an AI: MCP server, integrated assistant, external brain).
- L2: the platform has a read-only channel between modules (`reader`, for a module that lists the other in `dependsOn`); the guide's gap 4 was wrong about that and is corrected with this feature.
- L3: end-to-end on an isolated worktree and database with the real build, web server and worker, and a fake OpenAI-compatible model (inbox 0.3.0 and assistant 0.1.0 installed from the archives). A: switched off (the default), a customer wrote and nothing was answered and the model got 0 requests. B: switched on from the form (303), a customer wrote, the model was asked with 2 messages (system plus the customer's line), the answer was stored in the inbox as a queued reply and `assistant.replies` has `sent`, `fake-model`, 20 and 8 tokens. C: "I want to talk to a human person" got "I will pass you to a person." and the conversation stopped with reason `handoff`; the next customer line got no answer. D: a person replied from the inbox form before the assistant's wait was over, the customer wrote again, nothing was answered and the conversation stopped with reason `human`, the claim released as failed with error `human`. E: `/assistant` showed Switched on, Active, Stopped, both reasons in words and the reply text. 2 model requests in all.
