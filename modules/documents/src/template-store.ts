import type { Queryable, TemplateKind } from "../web/queries.ts";
import type { TemplateInput } from "./template-rules.ts";
import { type VariableSettings, parseVariableSettings } from "./variables.ts";

/** SQL for templates. Every value goes in as a parameter. */

export interface Template extends TemplateInput {
  id: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  /** The settings of the variables asked per document; empty when there are none. */
  variables: VariableSettings;
}

const COLUMNS = "id, slug, name, kind, ref_prefix, body_html, counterparty_marker, variables, created_at, updated_at, archived_at";
const UNIQUE_VIOLATION = "23505";
const SLUG_CONSTRAINT = "templates_slug_key";

function toTemplate(row: Record<string, unknown>): Template {
  return {
    id: Number(row.id),
    slug: row.slug as string,
    name: row.name as string,
    kind: row.kind as TemplateKind,
    refPrefix: row.ref_prefix as string,
    bodyHtml: row.body_html as string,
    counterpartyMarker: (row.counterparty_marker as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    archivedAt: (row.archived_at as Date | null) ?? null,
    variables: parseVariableSettings(row.variables),
  };
}

/** Active (not archived) templates by name. */
export async function listTemplates(db: Queryable): Promise<Template[]> {
  const { rows } = await db.query(`select ${COLUMNS} from documents.templates where archived_at is null order by lower(name), id`);
  return rows.map(toTemplate);
}

/** One template, archived or not. */
export async function getTemplate(db: Queryable, id: number): Promise<Template | null> {
  const { rows } = await db.query(`select ${COLUMNS} from documents.templates where id = $1`, [id]);
  return rows[0] ? toTemplate(rows[0]) : null;
}

export async function getTemplateBySlug(db: Queryable, slug: string): Promise<Template | null> {
  const { rows } = await db.query(`select ${COLUMNS} from documents.templates where slug = $1`, [slug]);
  return rows[0] ? toTemplate(rows[0]) : null;
}

/** The slug is unique across archived templates too, so an archived slug stays reserved. */
export async function createTemplate(db: Queryable, input: TemplateInput, variables: VariableSettings = {}): Promise<{ ok: true; id: number } | { ok: false; reason: "slug-taken" }> {
  const { rows } = await db.query(
    `insert into documents.templates (slug, name, kind, ref_prefix, body_html, counterparty_marker, variables)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     on conflict (slug) do nothing
     returning id`,
    [input.slug, input.name, input.kind, input.refPrefix, input.bodyHtml, input.counterpartyMarker, JSON.stringify(variables)],
  );
  return rows[0] ? { ok: true, id: Number(rows[0].id) } : { ok: false, reason: "slug-taken" };
}

/**
 * Archived templates are not edited: they report `not-found` like a missing id. The variable settings are replaced
 * only when `variables` is given (an empty object clears them); without it the column is left as it is.
 */
export async function updateTemplate(db: Queryable, id: number, input: TemplateInput, variables?: VariableSettings): Promise<"updated" | "not-found" | "slug-taken"> {
  try {
    const { rows } = await db.query(
      `update documents.templates
       set slug = $2, name = $3, kind = $4, ref_prefix = $5, body_html = $6, counterparty_marker = $7,
           variables = case when $8::jsonb is null then variables else $8::jsonb end, updated_at = now()
       where id = $1 and archived_at is null
       returning id`,
      [id, input.slug, input.name, input.kind, input.refPrefix, input.bodyHtml, input.counterpartyMarker, variables === undefined ? null : JSON.stringify(variables)],
    );
    return rows[0] ? "updated" : "not-found";
  } catch (error) {
    const { code, constraint } = error as { code?: string; constraint?: string };
    if (code === UNIQUE_VIOLATION && constraint === SLUG_CONSTRAINT) return "slug-taken";
    throw error;
  }
}

/** True when an active template was archived by this call. */
export async function archiveTemplate(db: Queryable, id: number): Promise<boolean> {
  const { rows } = await db.query("update documents.templates set archived_at = now(), updated_at = now() where id = $1 and archived_at is null returning id", [id]);
  return rows.length === 1;
}

/** The variable settings of a template, read with the row locked until the transaction ends; null when there is no such template. */
export async function lockVariables(db: Queryable, id: number): Promise<VariableSettings | null> {
  const { rows } = await db.query("select variables from documents.templates where id = $1 for update", [id]);
  return rows[0] !== undefined ? parseVariableSettings(rows[0].variables) : null;
}

/**
 * Write the variable settings of a template. It writes that one column and nothing else (not the body, not `updated_at`),
 * so what the owner edited is never touched. True when the template exists.
 */
export async function setVariables(db: Queryable, id: number, variables: VariableSettings): Promise<boolean> {
  const { rows } = await db.query("update documents.templates set variables = $2::jsonb where id = $1 returning id", [id, JSON.stringify(variables)]);
  return rows.length === 1;
}
