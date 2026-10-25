# assistant

> Module reference. For the full catalog and installation, see the [README](../../README.md).

Answers the messages your customers send to the inbox by itself, with a language model. **It is off until you switch it on**, because
while it is on each customer's messages are read by the model provider you configure.

**Set it up** (needs the `inbox` module, 0.3.0 or later, and the worker running, because the answers are produced by a job):

1. In the platform's Settings screen, section Assistant: `llm.url` (the model endpoint, OpenAI-compatible: `https://api.openai.com/v1`,
   or `http://127.0.0.1:11434/v1` for a local server such as Ollama), `llm.key` (empty for a local server), `llm.model`, `inbox_url`
   (this platform's own address, for example `http://127.0.0.1:3000`) and `inbox_token`. The token is a service token of the inbox:
   `npm run modunexo -- tokens create inbox --name assistant --scope messages.write` (it is shown once).
2. On `/assistant/settings`, write the **instructions** (who the business is, what it sells, hours, prices, tone, what the assistant
   must not do: the model only knows what is written there) and tick *Answer customers by itself*.
3. `/assistant` shows the state, a line per recent conversation with Pause and Resume, and the latest replies with their text.

**How it decides**
- A customer message makes the inbox announce `inbox.message.received`; the assistant's job waits a few seconds (default 5) so a burst
  of lines is answered once, answers only the newest customer message, and never one older than 15 minutes.
- It asks the model with your instructions, fixed rules (reply in the customer's language, keep it short, never invent prices,
  availability or promises, answer with `[[HANDOFF]]` to pass the customer to a person) and the last messages of the conversation
  (default 20). Only message texts are sent; no names or contact details.
- It sends the answer through the inbox's service API, so it is stored and delivered exactly like a reply written by hand.
- **One reply per customer message**, even if the job runs twice or two jobs run together; and if a send fails halfway, a retry does
  not send a second reply.
- **It stops by itself** in a conversation, and shows why on `/assistant`, when a person has written in it (`human`), when the model
  asked for a person (`handoff`; any text around the marker is still sent), or at the hourly limit (`limit`, default 10 replies per
  conversation). It stays stopped until someone presses Resume. You can also stop one by hand.
- **If the customer writes again while it works**, it throws away the answer it was preparing (it was about an older message) and
  answers the newest one with everything in view, up to three rounds. Just before sending it checks again that the assistant is still
  on, that the conversation is not stopped and that no person has written meanwhile; if any changed, nothing is sent.
- If the customer keeps writing through all three rounds, the last answer is sent and the message still waiting gets a job of its own,
  so no customer message is left without an assistant looking at it.
- **Resume starts the conversation again from its newest message**: a person who wrote earlier, or the replies of the last hour, no
  longer stop it at once. If a person writes after that, it stops again.
- If the connection to the inbox drops while a reply is being sent, the assistant cannot know whether it went out, so it stops in
  that conversation (shown as *a person wrote*) rather than risk answering twice. Press Resume if it did not go out.
- A failing model or inbox makes the job retry (3 attempts); the error shows the status or a fixed phrase, never the address,
  the key, the token or what the provider said.

**Not yet**: it cannot look up contacts or book appointments on its own (the contacts and agenda APIs exist, but the model has no tools
yet), it reads text only (no images or voice), one set of instructions for every channel, and it cannot be switched on for just
some conversations.
