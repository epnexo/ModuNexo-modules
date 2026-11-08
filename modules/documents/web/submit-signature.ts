import { describeDbError } from "../src/db-error.ts";
import { describeDocusealError, refreshedMessage } from "../src/docuseal-messages.ts";
import { parseDocumentId } from "../src/document-rules.ts";
import { type RefreshDeps, refreshSignature } from "../src/refresh-signature.ts";
import { type SendDeps, type SendResult, type SendStep, clearUnfinishedSend, sendForSignature } from "../src/send-signature.ts";
import type { ClearSendFormState, DocumentFormState, FormInput, RefreshFormState } from "./form-state.ts";
import type { Queryable } from "./queries.ts";
import { logFailure } from "./log.ts";

/** What the signature forms do with a submission, apart from reading FormData and navigating. */

export type SendOutcome = { state: DocumentFormState } | { redirectTo: string };

const GONE = "This document no longer exists.";
const STEP_PHRASE: Record<SendStep, string> = {
  find: "looking for the template",
  read: "reading the template",
  fields: "placing the signature fields",
  submission: "creating the signature request",
};

/** What was typed, to show again after a failure that is not about a field. The document id is plumbing and is left out. */
function entered(raw: FormInput): Record<string, string> {
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0] !== "documentId"));
}

function sendMessage(result: Exclude<SendResult, { ok: true } | { kind: "invalid" } | { kind: "already-sent" }>): string {
  switch (result.kind) {
    case "not-configured":
      return describeDocusealError({ kind: "not-configured" });
    case "not-found":
      return GONE;
    case "wrong-status":
      return "Only a generated document can be sent for signature. Reload the page to see its current state.";
    case "not-ready":
      return `This document is not ready for signature. ${result.reason}`;
    case "not-uploaded":
      return `The PDF ${result.fileName} is not in DocuSeal yet. Upload it in DocuSeal without renaming it, then send again.`;
    case "docuseal":
      return `DocuSeal failed while ${STEP_PHRASE[result.step]}. ${describeDocusealError(result.error)}`;
    case "unfinished":
      return "A send of this document is running, or an earlier one did not finish. Wait a minute and reload the page; if it then shows an unfinished send, follow the steps there before sending again.";
    case "outcome-unknown":
      return `DocuSeal did not confirm whether it created the signature request. ${describeDocusealError(result.error)} Do not send again yet: reload the page and follow the steps for an unfinished send.`;
    case "unrecorded":
      return `DocuSeal created the signature request (submission ${result.submissionId}) but the platform could not save it. Do not send it again: the ids are in the server log so the request can be recovered, and the page shows an unfinished send until you clear it.`;
  }
}

/** The dependencies are built inside the guard, like the new-document form: a server started from an unexpected place must still answer on the form. */
export async function submitSendWith(makeDeps: () => SendDeps | Promise<SendDeps>, raw: FormInput, send: typeof sendForSignature = sendForSignature): Promise<SendOutcome> {
  const documentId = parseDocumentId(raw.documentId);
  if (documentId === null) return { state: { values: entered(raw), errors: {}, message: GONE } };

  try {
    const result = await send(await makeDeps(), documentId, raw);
    if (result.ok) return { redirectTo: `/documents/${documentId}?sent=1` };
    if (result.kind === "already-sent") return { redirectTo: `/documents/${documentId}?sent=already` };
    if (result.kind === "invalid") return { state: { values: result.values, errors: result.errors } };
    return { state: { values: entered(raw), errors: {}, message: sendMessage(result) } };
  } catch (error) {
    logFailure("could not send a document for signature", error);
    return { state: { values: entered(raw), errors: {}, message: describeDbError(error).message } };
  }
}

export async function submitRefreshWith(makeDeps: () => RefreshDeps | Promise<RefreshDeps>, raw: FormInput, refresh: typeof refreshSignature = refreshSignature): Promise<RefreshFormState> {
  const documentId = parseDocumentId(raw.documentId);
  if (documentId === null) return { message: GONE };

  try {
    const result = await refresh(await makeDeps(), documentId);
    if (result.ok) {
      if (result.outcome === "unknown") return { note: `DocuSeal reported the status "${result.reported}", which this app does not know. The document was not changed.` };
      if (result.outcome === "updated") return { done: refreshedMessage(result.status), ...(result.status === "sent" ? {} : { moved: result.status }) };
      return { done: result.signersChanged ? "Signer progress updated. Still waiting for signatures." : "Still waiting for signatures." };
    }
    switch (result.kind) {
      case "not-configured":
        return { message: describeDocusealError({ kind: "not-configured" }) };
      case "not-found":
        return { message: GONE };
      case "not-sent":
        return { message: "This document is not waiting for signatures." };
      case "docuseal":
        return { message: describeDocusealError(result.error) };
      case "stale":
        return { message: "The document changed while its status was being read. Reload the page." };
    }
  } catch (error) {
    logFailure("could not refresh a signature status", error);
    return { message: describeDbError(error).message };
  }
}

/** The owner clears the mark of an unfinished send. It touches only the database and navigates back to the page, which shows the confirmation. */
export async function submitClearSendWith(makeDeps: () => { db: Queryable }, raw: FormInput, clear: typeof clearUnfinishedSend = clearUnfinishedSend): Promise<{ state: ClearSendFormState } | { redirectTo: string }> {
  const documentId = parseDocumentId(raw.documentId);
  if (documentId === null) return { state: { message: GONE } };
  try {
    const outcome = await clear(makeDeps().db, documentId);
    if (outcome === "cleared") return { redirectTo: `/documents/${documentId}?sent=cleared` };
    if (typeof outcome === "object") {
      const minutes = Math.ceil(outcome.waitMs / 60_000);
      return { state: { message: `The send may still be running, so it cannot be cleared yet. Try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}; the page will show the same notice until then.` } };
    }
    return { state: { message: "This document has no unfinished send to clear. Reload the page to see its current state." } };
  } catch (error) {
    logFailure("could not clear an unfinished send", error);
    return { state: { message: describeDbError(error).message } };
  }
}

/** What the refresh action does after a refresh: the page path to revalidate, and where to go when the form that would show the result is about to disappear. */
export function refreshNavigation(documentId: number | null, state: RefreshFormState): { revalidate: string | null; redirectTo: string | null } {
  if (documentId === null) return { revalidate: null, redirectTo: null };
  const path = `/documents/${documentId}`;
  if (state.moved !== undefined) return { revalidate: path, redirectTo: `${path}?refreshed=${state.moved}` };
  return { revalidate: state.message === undefined ? path : null, redirectTo: null };
}
