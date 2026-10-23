# inbox

## 0.2.0 - 2026-10-23

- The inbox no longer keeps contacts. A conversation holds `contact_ref`, a `contact_name` snapshot and `contact_id`, the id of
  the contact in the `contacts` module (empty until linked). The webhook's body and answers did not change.
- Optional link to `contacts`: settings `contacts_url` and `contacts_token`; a job `link_contact` finds or creates the contact by
  identity `<channel>:<reference>` and stores its id.
- Migration `0002` copies each contact's reference and name onto its conversations, empties `contact_id` and drops the inbox's
  `contacts` table. Messages, threads, unread counts and dedupe keys are untouched.

## 0.1.0 - 2026-10-21

- Signed webhook `POST /hooks/inbox/messages` (HMAC-SHA256, deduplicated by channel and message id), conversations and messages.
- The `/inbox` page with live refresh, replies delivered by the job `deliver` to an outbound URL (http or https) with retries.
- Event `message.received`; permissions `inbox.read` and `inbox.write`.
