import { SDK_VERSION, defineModule } from "@modunexo/sdk";

export default defineModule({
  id: "assistant",
  version: "0.1.0", // raise it whenever a migration is added: an upgrade to the same version does nothing
  name: "Assistant",
  platform: `^${SDK_VERSION}`,
  dependsOn: { inbox: "^0.3.0" },
  schema: "assistant", // the Postgres schema this module owns
  migrationsDir: "migrations",
  permissions: [
    { key: "assistant.read", label: "See what the assistant does" },
    { key: "assistant.write", label: "Switch the assistant on and off, change its instructions, stop and resume conversations" },
  ],
  settings: [
    { key: "llm.url", label: "Model endpoint", type: "string", required: true, description: "OpenAI-compatible, for example https://api.openai.com/v1 or http://127.0.0.1:11434/v1 for a local server." },
    { key: "llm.key", label: "Model API key", type: "secret", description: "Leave empty for a local server that needs none." },
    { key: "llm.model", label: "Model", type: "string", description: "The model that answers, for example gpt-4o-mini or llama3.2." },
    { key: "inbox_url", label: "Platform address", type: "string", required: true, description: "The address of this platform (for example http://127.0.0.1:3000), used to send replies through the inbox." },
    { key: "inbox_token", label: "Inbox token", type: "secret", required: true, description: "A service token of the inbox module with the scope messages.write." },
  ],
  llm: { baseUrlSetting: "llm.url", apiKeySetting: "llm.key", modelSetting: "llm.model" },
  jobs: [{ name: "answer", entry: "./jobs/answer.ts", timeoutSeconds: 120, maxAttempts: 3 }],
  subscriptions: [{ event: "inbox.message.received", job: "answer" }],
  nav: [],
});
