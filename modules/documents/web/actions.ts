"use server";

import { getDb } from "@modunexo/sdk";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { docusealFromEnv } from "../src/docuseal-client.ts";
import { documentsDir } from "../src/file-store.ts";
import { pdfEngineFromEnv } from "../src/pdf-engine.ts";
import { parseDocumentId } from "../src/document-rules.ts";
import type { ArchiveFormState, ClearSendFormState, DocumentFormState, FormInput, ProfileFormState, RefreshFormState, TemplateFormState } from "./form-state.ts";
import { submitNewDocumentWith } from "./submit-document.ts";
import { refreshNavigation, submitClearSendWith, submitRefreshWith, submitSendWith } from "./submit-signature.ts";
import { submitArchive, submitNewTemplate, submitProfile, submitTemplateUpdate } from "./submit.ts";

/**
 * The module's server actions. They are reachable by POST, so everything is validated in `submit.ts`; here they only
 * read the form, call it and navigate. The pages are dynamic, so nothing needs revalidating. A file marked "use server" may export async functions only.
 */

function fields(formData: FormData): FormInput {
  const input: FormInput = {};
  formData.forEach((value, key) => {
    if (typeof value === "string") input[key] = value;
  });
  return input;
}

export async function createTemplateAction(_previous: TemplateFormState, formData: FormData): Promise<TemplateFormState> {
  const outcome = await submitNewTemplate(getDb("documents"), fields(formData));
  if ("redirectTo" in outcome) redirect(outcome.redirectTo);
  return outcome.state;
}

export async function updateTemplateAction(_previous: TemplateFormState, formData: FormData): Promise<TemplateFormState> {
  const outcome = await submitTemplateUpdate(getDb("documents"), fields(formData));
  if ("redirectTo" in outcome) redirect(outcome.redirectTo);
  return outcome.state;
}

export async function archiveTemplateAction(_previous: ArchiveFormState, formData: FormData): Promise<ArchiveFormState> {
  const outcome = await submitArchive(getDb("documents"), fields(formData));
  if ("redirectTo" in outcome) redirect(outcome.redirectTo);
  return outcome.state;
}

export async function saveProfileAction(_previous: ProfileFormState, formData: FormData): Promise<ProfileFormState> {
  return submitProfile(getDb("documents"), fields(formData));
}

export async function createDocumentAction(_previous: DocumentFormState, formData: FormData): Promise<DocumentFormState> {
  const outcome = await submitNewDocumentWith(() => ({ db: getDb("documents"), engine: pdfEngineFromEnv(), dir: documentsDir() }), fields(formData));
  if ("redirectTo" in outcome) redirect(outcome.redirectTo);
  return outcome.state;
}

/** The pool and the DocuSeal client (null when `DOCUSEAL_URL` or `DOCUSEAL_API_TOKEN` is missing), built when an action runs. */
function signingDeps() {
  const client = docusealFromEnv(process.env);
  return { db: getDb("documents"), docuseal: client.ok ? client.value : null };
}

export async function sendForSignatureAction(_previous: DocumentFormState, formData: FormData): Promise<DocumentFormState> {
  const outcome = await submitSendWith(signingDeps, fields(formData));
  if ("redirectTo" in outcome) redirect(outcome.redirectTo);
  return outcome.state;
}

export async function clearUnfinishedSendAction(_previous: ClearSendFormState, formData: FormData): Promise<ClearSendFormState> {
  const outcome = await submitClearSendWith(() => ({ db: getDb("documents") }), fields(formData));
  if ("redirectTo" in outcome) redirect(outcome.redirectTo);
  return outcome.state;
}

export async function refreshSignatureAction(_previous: RefreshFormState, formData: FormData): Promise<RefreshFormState> {
  const input = fields(formData);
  const state = await submitRefreshWith(signingDeps, input);
  // A refresh that wrote something must show on the page the button sits on, also when it then redirects.
  const { revalidate, redirectTo } = refreshNavigation(parseDocumentId(input.documentId), state);
  if (revalidate !== null) revalidatePath(revalidate);
  if (redirectTo !== null) redirect(redirectTo);
  return state;
}
