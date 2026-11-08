import type { DocusealError } from "./docuseal-client.ts";

/** How a DocuSeal failure reads to the owner and in the server log. Nothing from an answer is echoed. */

/** A short code for the log: the kind, and the HTTP status where there is one. Never a message, an address or a value. */
export function docusealCode(error: DocusealError): string {
  switch (error.kind) {
    case "unreachable":
      return `docuseal-unreachable-${error.reason}`;
    case "outcome-unknown":
      return `docuseal-outcome-unknown-${error.reason}`;
    case "unauthorized":
    case "rejected":
    case "server-error":
      return `docuseal-${error.kind}-${error.status}`;
    default:
      return `docuseal-${error.kind}`;
  }
}

export function describeDocusealError(error: DocusealError): string {
  switch (error.kind) {
    case "not-configured":
      return "Signing is not configured. Set the DocuSeal address and API token in the Documents settings.";
    case "unreachable":
      return error.reason === "timeout" ? "DocuSeal did not answer in time. Try again in a moment." : "DocuSeal could not be reached. Check the DocuSeal address in the Documents settings and that the server is running.";
    case "outcome-unknown":
      return "DocuSeal may have created the signature request, but this app could not confirm it. Check in DocuSeal before sending again.";
    case "unauthorized":
      return "DocuSeal refused the API token. Check the DocuSeal API token in the Documents settings.";
    case "not-found":
      return "DocuSeal could not find what was asked for. It may have been deleted there.";
    case "rejected":
      return `DocuSeal rejected the request (HTTP ${error.status}). Check the template and the signers in DocuSeal.`;
    case "server-error":
      return `DocuSeal had a problem (HTTP ${error.status}). Try again later.`;
    case "unexpected":
      return "DocuSeal answered in a way this app does not understand. Check that the DocuSeal version is the one the app was built for.";
    case "refused-url":
      return "DocuSeal pointed to an address outside the configured server, so the app did not use it.";
  }
}

/** The confirmation of a refresh that changed the document status; the page shows it again after the redirect. */
export const refreshedMessage = (status: string): string => `Status updated: the document is ${status}.`;
