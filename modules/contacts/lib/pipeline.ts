import { getDb, publishEvent } from "@modunexo/sdk";
import { hasNul, type Checked } from "./contacts.ts";

const MODULE = "contacts";

export type StageKind = "open" | "won" | "lost";
export type Priority = "low" | "normal" | "high";
export type StageRow = { id: number; name: string; position: number; kind: StageKind };
export type LeadRow = { id: number; contactId: number; contactName: string; title: string; amount: number | null; priority: Priority; closedAt: Date | null; createdAt: Date };
export type LeadFields = { contactId: number; title: string; amount: number | null; priority: Priority };
export type ContactLead = { id: number; title: string; amount: number | null; priority: Priority; stage: string; closedAt: Date | null };
export type HistoryRow = { from: string | null; to: string; at: Date };

type RawStage = { id: string; name: string; position: number; kind: StageKind };
type RawLead = { id: string; contact_id: string; contact_name: string; title: string; amount: string | null; priority: Priority; closed_at: Date | null; created_at: Date; stage_id: string };

const PRIORITIES: readonly Priority[] = ["low", "normal", "high"];
const text = (raw: unknown): string | null => (typeof raw === "string" && !hasNul(raw) ? raw.trim() : null);

/** The name of a stage: 1 to 80 characters. */
export function stageName(raw: unknown): Checked<string> {
  const name = text(raw);
  if (name === null || name === "" || name.length > 80) return { ok: false, error: '"name" must be a text of 1 to 80 characters.' };
  return { ok: true, value: name };
}

/** Checks what the new-lead form sends; the error names the first field that cannot be used. */
export function leadInput(raw: Record<string, unknown>): Checked<LeadFields> {
  const contactId = typeof raw.contactId === "number" ? String(raw.contactId) : text(raw.contactId);
  if (contactId === null || !/^\d{1,15}$/.test(contactId)) return { ok: false, error: '"contactId" must be a number.' };
  const title = text(raw.title);
  if (title === null || title === "" || title.length > 200) return { ok: false, error: '"title" must be a text of 1 to 200 characters.' };
  const rawAmount = typeof raw.amount === "number" ? String(raw.amount) : raw.amount === undefined || raw.amount === null ? "" : text(raw.amount);
  if (rawAmount === null || (rawAmount !== "" && !/^\d{1,12}(\.\d{1,2})?$/.test(rawAmount))) return { ok: false, error: '"amount" must be a positive number with at most 2 decimals.' };
  const rawPriority = raw.priority === undefined || raw.priority === null ? "" : text(raw.priority);
  if (rawPriority === null || (rawPriority !== "" && !PRIORITIES.includes(rawPriority as Priority))) return { ok: false, error: '"priority" must be low, normal or high.' };
  return { ok: true, value: { contactId: Number(contactId), title, amount: rawAmount === "" ? null : Number(rawAmount), priority: (rawPriority || "normal") as Priority } };
}

const toStage = (row: RawStage): StageRow => ({ id: Number(row.id), name: row.name, position: row.position, kind: row.kind });

export async function listStages(): Promise<StageRow[]> {
  const found = await getDb(MODULE).query<RawStage>("select id, name, position, kind from pipeline_stages order by position");
  return found.rows.map(toStage);
}

/** Adds an open stage just before the first closing one (Won or Lost), so the closing stages stay last. */
export async function addStage(name: string): Promise<{ ok: true; id: number }> {
  return getDb(MODULE).transaction(async (tx) => {
    await tx.query("lock table pipeline_stages in share row exclusive mode");
    const edge = await tx.query<{ position: number | null }>("select min(position) as position from pipeline_stages where kind <> 'open'");
    const last = await tx.query<{ position: number | null }>("select max(position) as position from pipeline_stages");
    const at = edge.rows[0]?.position ?? (last.rows[0]?.position ?? 0) + 1;
    await tx.query("update pipeline_stages set position = position + 1 where position >= $1", [at]);
    const added = await tx.query<{ id: string }>("insert into pipeline_stages (name, position, kind) values ($1, $2, 'open') returning id", [name, at]);
    return { ok: true as const, id: Number(added.rows[0]!.id) };
  });
}

export async function renameStage(id: number, name: string): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
  const renamed = await getDb(MODULE).query("update pipeline_stages set name = $2 where id = $1", [id, name]);
  return renamed.rowCount === 0 ? { ok: false, error: "not_found" } : { ok: true };
}

/** Creates a lead in the first stage and records where it started; a new lead announces nothing. */
export async function createLead(fields: LeadFields): Promise<{ ok: true; id: number } | { ok: false; error: "contact_not_found" }> {
  return getDb(MODULE).transaction(async (tx) => {
    const contact = await tx.query("select 1 from contacts where id = $1", [fields.contactId]);
    if (contact.rows.length === 0) return { ok: false as const, error: "contact_not_found" as const };
    const first = await tx.query<{ id: string }>("select id from pipeline_stages order by position limit 1");
    const stage = first.rows[0]!.id;
    const made = await tx.query<{ id: string }>(
      "insert into leads (contact_id, stage_id, title, amount, priority) values ($1, $2, $3, $4, $5) returning id",
      [fields.contactId, stage, fields.title, fields.amount, fields.priority],
    );
    const id = Number(made.rows[0]!.id);
    await tx.query("insert into lead_stage_events (lead_id, from_stage_id, to_stage_id) values ($1, null, $2)", [id, stage]);
    return { ok: true as const, id };
  });
}

/**
 * Moves a lead to a stage: the stage, `closed_at` (set in a closing stage, cleared in an open one), the history row and
 * the `lead.stage_changed` event are one transaction. The lead row is locked first, so moves that arrive together are
 * applied one after the other and each history row starts where the previous one ended.
 */
export async function moveLead(leadId: number, stageId: number): Promise<{ ok: true; changed: boolean } | { ok: false; error: "lead_not_found" | "stage_not_found" }> {
  return getDb(MODULE).transaction(async (tx) => {
    const found = await tx.query<{ contact_id: string; stage_id: string }>("select contact_id, stage_id from leads where id = $1 for update", [leadId]);
    const current = found.rows[0];
    if (current === undefined) return { ok: false as const, error: "lead_not_found" as const };
    const target = await tx.query<{ kind: StageKind }>("select kind from pipeline_stages where id = $1", [stageId]);
    if (target.rows[0] === undefined) return { ok: false as const, error: "stage_not_found" as const };
    if (Number(current.stage_id) === stageId) return { ok: true as const, changed: false };
    const kind = target.rows[0].kind;
    await tx.query("update leads set stage_id = $2, closed_at = case when $3 <> 'open' then clock_timestamp() else null end, updated_at = clock_timestamp() where id = $1", [leadId, stageId, kind]);
    await tx.query("insert into lead_stage_events (lead_id, from_stage_id, to_stage_id) values ($1, $2, $3)", [leadId, current.stage_id, stageId]);
    await publishEvent(
      MODULE,
      "lead.stage_changed",
      { leadId, contactId: Number(current.contact_id), fromStageId: Number(current.stage_id), toStageId: stageId, toKind: kind },
      { tx },
    );
    return { ok: true as const, changed: true };
  });
}

/** Every stage in order with the leads in it, newest first. */
export async function loadBoard(): Promise<(StageRow & { leads: LeadRow[] })[]> {
  const stages = await listStages();
  const found = await getDb(MODULE).query<RawLead>(
    "select l.id, l.contact_id, c.name as contact_name, l.title, l.amount, l.priority, l.closed_at, l.created_at, l.stage_id from leads l join contacts c on c.id = l.contact_id order by l.id desc",
  );
  return stages.map((stage) => ({
    ...stage,
    leads: found.rows
      .filter((row) => Number(row.stage_id) === stage.id)
      .map((row) => ({ id: Number(row.id), contactId: Number(row.contact_id), contactName: row.contact_name, title: row.title, amount: row.amount === null ? null : Number(row.amount), priority: row.priority, closedAt: row.closed_at, createdAt: row.created_at })),
  }));
}

export async function leadsOfContact(contactId: number): Promise<ContactLead[]> {
  const found = await getDb(MODULE).query<{ id: string; title: string; amount: string | null; priority: Priority; stage: string; closed_at: Date | null }>(
    "select l.id, l.title, l.amount, l.priority, s.name as stage, l.closed_at from leads l join pipeline_stages s on s.id = l.stage_id where l.contact_id = $1 order by l.id desc",
    [contactId],
  );
  return found.rows.map((row) => ({ id: Number(row.id), title: row.title, amount: row.amount === null ? null : Number(row.amount), priority: row.priority, stage: row.stage, closedAt: row.closed_at }));
}

/** Where a lead has been, oldest first; `from` is null for the stage it started in. */
export async function leadHistory(leadId: number): Promise<HistoryRow[]> {
  const found = await getDb(MODULE).query<{ from_name: string | null; to_name: string; occurred_at: Date }>(
    "select f.name as from_name, t.name as to_name, e.occurred_at from lead_stage_events e left join pipeline_stages f on f.id = e.from_stage_id join pipeline_stages t on t.id = e.to_stage_id where e.lead_id = $1 order by e.id",
    [leadId],
  );
  return found.rows.map((row) => ({ from: row.from_name, to: row.to_name, at: row.occurred_at }));
}
