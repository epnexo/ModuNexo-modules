import { listContacts } from "../lib/contacts.ts";
import { loadBoard, type LeadRow, type StageRow } from "../lib/pipeline.ts";
import { BUTTON, BUTTON_QUIET, INPUT, money } from "./ui.ts";

export const metadata = { title: "Pipeline" };

function Lead({ lead, stages, stageId }: { lead: LeadRow; stages: StageRow[]; stageId: number }) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3 text-sm">
      <span className="font-medium">{lead.title}</span>
      <a href={`/contacts?c=${lead.contactId}`} className="text-muted underline-offset-4 hover:underline">
        {lead.contactName}
      </a>
      <span className="text-xs text-muted">
        {lead.amount === null ? "No amount" : money(lead.amount)} · {lead.priority}
      </span>
      <form method="post" action="/pipeline/move" className="flex gap-2">
        <input type="hidden" name="leadId" value={lead.id} />
        <select name="stageId" defaultValue={stageId} aria-label={`Stage of ${lead.title}`} className={`min-w-0 flex-1 ${INPUT} py-1`}>
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </select>
        <button type="submit" className={BUTTON_QUIET}>
          Move
        </button>
      </form>
    </li>
  );
}

export default async function Page() {
  const board = await loadBoard();
  const contacts = await listContacts();
  const stages: StageRow[] = board.map(({ id, name, position, kind }) => ({ id, name, position, kind }));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>

      <div className="flex flex-wrap gap-4">
        {contacts.length === 0 ? (
          <p role="note" className="rounded-md bg-warning-soft px-3 py-2 text-sm">
            Add a contact first: a lead belongs to a contact.
          </p>
        ) : (
          <form method="post" action="/pipeline/lead" className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="new-lead-contact" className="text-sm font-medium">
                New lead for
              </label>
              <select id="new-lead-contact" name="contactId" className={INPUT}>
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name}
                  </option>
                ))}
              </select>
            </div>
            <input name="title" required maxLength={200} placeholder="Title" aria-label="Title" className={INPUT} />
            <input name="amount" inputMode="decimal" placeholder="Amount" aria-label="Amount" className={`w-28 ${INPUT}`} />
            <select name="priority" defaultValue="normal" aria-label="Priority" className={INPUT}>
              <option value="low">low</option>
              <option value="normal">normal</option>
              <option value="high">high</option>
            </select>
            <button type="submit" className={BUTTON}>
              Add lead
            </button>
          </form>
        )}
        <form method="post" action="/pipeline/stage" className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="new-stage" className="text-sm font-medium">
              New stage
            </label>
            <input id="new-stage" name="name" required maxLength={80} className={INPUT} />
          </div>
          <button type="submit" className={BUTTON_QUIET}>
            Add stage
          </button>
        </form>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-2">
        {board.map((column) => (
          <section key={column.id} aria-label={column.name} className="flex w-72 shrink-0 flex-col gap-3 rounded-lg border border-border bg-panel p-3">
            <header className="flex items-center justify-between gap-2">
              <h2 className="font-semibold">{column.name}</h2>
              <span className="text-xs text-muted">{column.leads.length}</span>
            </header>
            <details>
              <summary className="cursor-pointer text-xs text-muted">Rename</summary>
              <form method="post" action="/pipeline/stage" className="flex gap-2 pt-2">
                <input type="hidden" name="id" value={column.id} />
                <input name="name" required maxLength={80} defaultValue={column.name} aria-label={`New name of ${column.name}`} className={`min-w-0 flex-1 ${INPUT} py-1`} />
                <button type="submit" className={BUTTON_QUIET}>
                  Save
                </button>
              </form>
            </details>
            {column.leads.length === 0 ? (
              <p className="text-sm text-muted">No lead here.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {column.leads.map((lead) => (
                  <Lead key={lead.id} lead={lead} stages={stages} stageId={column.id} />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
