import { getContact, listContacts, type ContactRow } from "../lib/contacts.ts";
import { leadsOfContact, type ContactLead } from "../lib/pipeline.ts";
import { BUTTON, BUTTON_DANGER, BUTTON_QUIET, INPUT, money, when } from "./ui.ts";

export const metadata = { title: "Contacts" };

type Params = { q?: string | string[]; c?: string | string[] };

function Field({ name, label, value, type = "text", required = false, max }: { name: string; label: string; value?: string | null; type?: string; required?: boolean; max: number }) {
  const id = `f-${name}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input id={id} name={name} type={type} defaultValue={value ?? ""} required={required} maxLength={max} className={INPUT} />
    </div>
  );
}

function ContactForm({ contact }: { contact?: ContactRow }) {
  return (
    <form method="post" action="/contacts/save" className="flex flex-col gap-3">
      {contact === undefined ? null : <input type="hidden" name="id" value={contact.id} />}
      <Field name="name" label="Name" value={contact?.name} required max={200} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field name="phone" label="Phone" value={contact?.phone} max={40} />
        <Field name="email" label="Email" value={contact?.email} max={200} />
      </div>
      <Field name="identity" label="Channel identity" value={contact?.identity} max={200} />
      <div className="flex flex-col gap-1">
        <label htmlFor="f-notes" className="text-sm font-medium">
          Notes
        </label>
        <textarea id="f-notes" name="notes" rows={3} maxLength={4000} defaultValue={contact?.notes ?? ""} className={INPUT} />
      </div>
      <button type="submit" className={BUTTON}>
        {contact === undefined ? "Add contact" : "Save"}
      </button>
    </form>
  );
}

function NewLead({ contactId }: { contactId: number }) {
  return (
    <form method="post" action="/pipeline/lead" className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="contactId" value={contactId} />
      <div className="flex flex-col gap-1">
        <label htmlFor="lead-title" className="text-sm font-medium">
          New lead
        </label>
        <input id="lead-title" name="title" required maxLength={200} placeholder="Title" className={INPUT} />
      </div>
      <input name="amount" inputMode="decimal" placeholder="Amount" aria-label="Amount" className={`w-28 ${INPUT}`} />
      <select name="priority" defaultValue="normal" aria-label="Priority" className={INPUT}>
        <option value="low">low</option>
        <option value="normal">normal</option>
        <option value="high">high</option>
      </select>
      <button type="submit" className={BUTTON_QUIET}>
        Add lead
      </button>
    </form>
  );
}

function Leads({ leads }: { leads: ContactLead[] }) {
  if (leads.length === 0) return <p className="text-sm text-muted">No lead for this contact yet.</p>;
  return (
    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
      {leads.map((lead) => (
        <li key={lead.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
          <span className="font-medium">{lead.title}</span>
          <span className="text-muted">
            {lead.stage}
            {lead.amount === null ? "" : ` · ${money(lead.amount)}`} · {lead.priority}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<Params> }) {
  const { q, c } = await searchParams;
  const search = typeof q === "string" ? q : "";
  const asked = typeof c === "string" && /^\d{1,15}$/.test(c) ? Number(c) : null;
  const rows = await listContacts(search);
  const selected = asked === null ? null : await getContact(asked);
  const leads = selected === null ? [] : await leadsOfContact(selected.id);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
      <div className="grid gap-4 md:grid-cols-[20rem_1fr]">
        <div className="flex flex-col gap-3">
          <form method="get" action="/contacts" role="search" className="flex gap-2">
            <input name="q" type="search" defaultValue={search} placeholder="Search" aria-label="Search contacts" className={`min-w-0 flex-1 ${INPUT}`} />
            <button type="submit" className={BUTTON_QUIET}>
              Search
            </button>
          </form>
          <details className="rounded-lg border border-border bg-surface p-3">
            <summary className="cursor-pointer text-sm font-medium">Add a contact</summary>
            <div className="pt-3">
              <ContactForm />
            </div>
          </details>
          <nav aria-label="Contacts" className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            {rows.length === 0 ? (
              <p className="p-4 text-sm text-muted">{search === "" ? "No contact yet. Add the first one with the form above." : "No contact matches that search."}</p>
            ) : (
              rows.map((row) => (
                <a key={row.id} href={`/contacts?c=${row.id}`} aria-current={selected?.id === row.id ? "page" : undefined} className={`flex flex-col gap-1 px-4 py-3 text-sm transition-colors duration-150 hover:bg-accent-soft ${selected?.id === row.id ? "bg-accent-soft" : ""}`}>
                  <span className="truncate font-medium">{row.name}</span>
                  <span className="truncate text-muted">{row.email ?? row.phone ?? row.identity ?? ""}</span>
                </a>
              ))
            )}
          </nav>
        </div>

        <section aria-label="Contact" className="flex min-h-64 flex-col gap-4 rounded-lg border border-border bg-surface p-4">
          {selected === null ? (
            <p className="text-sm text-muted">{asked === null ? "Select a contact." : "That contact does not exist."}</p>
          ) : (
            <>
              <h2 className="text-lg font-semibold tracking-tight">{selected.name}</h2>
              <p className="text-xs text-muted">
                Added <time dateTime={selected.createdAt.toISOString()}>{when(selected.createdAt)}</time>
              </p>
              <ContactForm contact={selected} />
              <h3 className="text-base font-semibold">Leads</h3>
              <Leads leads={leads} />
              <NewLead contactId={selected.id} />
              <form method="post" action="/contacts/delete" className="border-t border-border pt-4">
                <input type="hidden" name="id" value={selected.id} />
                <button type="submit" className={BUTTON_DANGER}>
                  Delete contact and its leads
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
