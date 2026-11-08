import { PROFILE_FIELDS } from "../src/profile.ts";
import { getProfile } from "../src/profile-store.ts";
import { getTemplate, listTemplates } from "../src/template-store.ts";
import type { NewDocumentData } from "./new-document-page.tsx";
import type { Queryable } from "./queries.ts";
import type { TemplateEditData } from "./template-edit-page.tsx";
import type { TemplatesPageData } from "./templates-page.tsx";

/** What each page reads, in one place so a test can run it against the database the same way the route does. */

export async function loadTemplatesData(db: Queryable): Promise<TemplatesPageData> {
  const [templates, profile] = await Promise.all([listTemplates(db), getProfile(db)]);
  return { templates, profile };
}

/** The template (archived or not) and the profile. `template` is null for an unknown id. */
export async function loadTemplateEditData(db: Queryable, id: number): Promise<TemplateEditData> {
  const [template, profile] = await Promise.all([getTemplate(db, id), getProfile(db)]);
  return { template, profile };
}

/** The stored profile as form values: every field key, blank when the profile does not have it. */
export async function loadProfileValues(db: Queryable): Promise<Record<string, string>> {
  const profile = await getProfile(db);
  return Object.fromEntries(PROFILE_FIELDS.map((field) => [field.key, profile[field.key] ?? ""]));
}

/** The active templates for the picker, and the template named in the URL with the profile that decides what it asks. */
export async function loadNewDocumentData(db: Queryable, templateId: number | null): Promise<NewDocumentData> {
  const [templates, chosen, profile] = await Promise.all([listTemplates(db), templateId === null ? null : getTemplate(db, templateId), getProfile(db)]);
  return { templates, chosen, profile };
}
