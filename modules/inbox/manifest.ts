import { SDK_VERSION, defineModule } from "@modunexo/sdk";
import { LINK_ATTEMPTS } from "./lib/link.ts";
import { DELIVER_ATTEMPTS } from "./lib/limits.ts";

export default defineModule({
  id: "inbox",
  version: "0.3.1", // raise it whenever a migration is added: an upgrade to the same version does nothing
  name: "Inbox",
  platform: `^${SDK_VERSION}`,
  dependsOn: {},
  schema: "inbox", // the Postgres schema this module owns
  migrationsDir: "migrations",
  permissions: [
    { key: "inbox.read", label: "Read conversations" },
    { key: "inbox.write", label: "Reply to conversations" },
  ],
  settings: [
    { key: "webhook_secret", label: "Webhook secret", type: "secret", required: true, description: "Shared key that signs the messages a channel sends to /hooks/inbox/messages." },
    { key: "outbound_url", label: "Outbound URL", type: "string", description: "Where a reply is sent. Leave empty to keep replies queued." },
    { key: "outbound_secret", label: "Outbound secret", type: "secret", description: "Shared key that signs the replies sent to the outbound URL." },
    { key: "contacts_url", label: "Contacts address", type: "string", description: "Address of this platform (for example http://127.0.0.1:3000), used to link each conversation to its contact in the contacts module. Leave empty to skip the link." },
    { key: "contacts_token", label: "Contacts token", type: "secret", description: "A service token of the contacts module with the scopes contacts.read and contacts.write." },
  ],
  scopes: [
    { key: "messages.read", label: "Read conversations and messages" },
    { key: "messages.write", label: "Send replies and mark conversations as read" },
  ],
  events: [{ name: "message.received", permission: "inbox.read" }],
  jobs: [
    { name: "deliver", entry: "./jobs/deliver.ts", timeoutSeconds: 30, maxAttempts: DELIVER_ATTEMPTS },
    { name: "link_contact", entry: "./jobs/link-contact.ts", timeoutSeconds: 30, maxAttempts: LINK_ATTEMPTS },
  ],
  nav: [{ label: "Inbox", href: "/inbox", icon: "app", permission: "inbox.read" }],
  dashboard: {
    stats: [
      { key: "conversations", label: "Conversations", href: "/inbox", permission: "inbox.read", sql: "select count(*) from conversations" },
      { key: "unread", label: "Unread conversations", href: "/inbox", permission: "inbox.read", sql: "select count(*) from conversations where unread_count > 0" },
      { key: "recent_messages", label: "Messages in the last 24 hours", href: "/inbox", permission: "inbox.read", sql: "select count(*) from messages where created_at > now() - interval '24 hours'" },
    ],
    alerts: [
      { key: "waiting", label: "Unread conversations waiting over an hour", href: "/inbox", severity: "warning", permission: "inbox.read", sql: "select count(*) from conversations where unread_count > 0 and last_message_at < now() - interval '1 hour'" },
      { key: "failed_replies", label: "Replies that failed to send this week", href: "/inbox", severity: "error", permission: "inbox.read", sql: "select count(*) from messages where direction = 'out' and status = 'failed' and created_at > now() - interval '7 days'" },
    ],
  },
  pages: [
    { path: "/inbox", entry: "./web/page.tsx", kind: "page", dynamic: "force-dynamic", permission: "inbox.read" },
    { path: "/inbox/reply", entry: "./web/reply.ts", kind: "route", methods: ["POST"], permission: "inbox.write" },
    {
      path: "/hooks/inbox/messages",
      entry: "./web/messages.ts",
      kind: "route",
      methods: ["POST"],
      public: { signature: { secret: "webhook_secret", header: "x-signature", encoding: "hex", prefix: "sha256=" }, ratePerMinute: 120, maxBodyBytes: 65536 },
    },
    { path: "/svc/inbox/conversations", entry: "./web/svc-conversations.ts", kind: "route", methods: ["GET"], scope: "messages.read" },
    { path: "/svc/inbox/messages", entry: "./web/svc-messages.ts", kind: "route", methods: ["GET"], scope: "messages.read" },
    { path: "/svc/inbox/messages/send", entry: "./web/svc-send.ts", kind: "route", methods: ["POST"], scope: "messages.write" },
    { path: "/svc/inbox/conversations/read", entry: "./web/svc-read.ts", kind: "route", methods: ["POST"], scope: "messages.write" },
  ],
});
