import { MAX_INSTRUCTIONS_CHARS, loadConfig } from "../lib/config.ts";
import { BUTTON, INPUT } from "./ui.ts";

export const metadata = { title: "Assistant settings" };

function NumberField({ name, label, value, min, max, help }: { name: string; label: string; value: number; min: number; max: number; help: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`a-${name}`} className="text-sm font-medium">
        {label}
      </label>
      <input id={`a-${name}`} name={name} type="number" min={min} max={max} defaultValue={value} required className={`w-32 ${INPUT}`} />
      <p className="max-w-xs text-xs text-muted">{help}</p>
    </div>
  );
}

export default async function Page() {
  const config = await loadConfig();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Assistant settings</h1>
        <a href="/assistant" className="text-sm underline-offset-4 hover:underline">
          Back to the assistant
        </a>
      </div>
      <form method="post" action="/assistant/settings/save" className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" name="enabled" defaultChecked={config.enabled} />
            Answer customers by itself
          </label>
          <p className="max-w-xl text-xs text-muted">
            While this is on, each message a customer sends is read by the model provider you configure in the platform&apos;s Settings screen (the model endpoint,
            the key and the model), and its answer is sent to the customer. Switch it off to stop at once. A conversation where a person writes is left to that person.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="a-instructions" className="text-sm font-medium">
            Instructions
          </label>
          <textarea id="a-instructions" name="instructions" rows={10} maxLength={MAX_INSTRUCTIONS_CHARS} defaultValue={config.instructions} className={INPUT} />
          <p className="max-w-xl text-xs text-muted">
            Who the business is, what it sells, its hours, prices, tone and what the assistant must not do. The model only knows what is written here. Up to {MAX_INSTRUCTIONS_CHARS} characters.
          </p>
        </div>
        <div className="flex flex-wrap gap-4">
          <NumberField name="waitSeconds" label="Wait before answering (seconds)" value={config.waitSeconds} min={0} max={60} help="So a customer who writes several lines is answered once." />
          <NumberField name="historyMessages" label="Messages the model reads" value={config.historyMessages} min={1} max={50} help="The latest messages of the conversation." />
          <NumberField name="maxRepliesPerHour" label="Replies per hour, per conversation" value={config.maxRepliesPerHour} min={1} max={100} help="At the limit the conversation is stopped until someone resumes it." />
        </div>
        <button type="submit" className={BUTTON}>
          Save
        </button>
      </form>
    </div>
  );
}
