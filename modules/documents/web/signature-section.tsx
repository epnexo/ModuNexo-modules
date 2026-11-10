import { refreshedMessage } from "../src/docuseal-messages.ts";
import type { DocumentDetail } from "../src/document-store.ts";
import { templateNameForPdf } from "../src/signature-payload.ts";
import type { SigningLink } from "../src/signature-store.ts";
import { Notice, Portlet } from "./components.tsx";
import { ClearSendForm, SignatureForm, RefreshForm } from "./forms.tsx";
import { ENDPOINTS } from "./endpoints.ts";
import { formatCreated } from "./registry.ts";

/** The signature part of the document page, for each state of a document. Everything shown from DocuSeal or the database is plain text. */

const SIGNER_STATUS: Record<string, string> = { awaiting: "Waiting for an earlier signer", sent: "Not opened yet", opened: "Opened", completed: "Signed", declined: "Declined" };

/** An absolute http or https URL, or null: a stored link is never used as an href otherwise. */
function safeHref(link: string): string | null {
  try {
    const protocol = new URL(link).protocol;
    return protocol === "http:" || protocol === "https:" ? link : null;
  } catch {
    return null;
  }
}

function signerTime(at: string | undefined): string {
  if (at === undefined) return "";
  const time = new Date(at);
  return Number.isNaN(time.getTime()) ? "" : formatCreated(time);
}

function NotConfigured() {
  return (
    <Notice title="Signing is not configured">
      Set the DocuSeal address and API token in the Documents settings.
    </Notice>
  );
}

/** A send that started and did not finish: DocuSeal may already hold a signature request the platform does not know of. */
function UnfinishedSend({ document }: { document: DocumentDetail }) {
  const templateName = document.pdfName === null ? null : templateNameForPdf(document.pdfName);
  return (
    <Portlet title="Signature">
      <div style={{ display: "grid", gap: "var(--portlet-pad)" }}>
        <Notice title="A send did not finish">
          Sending this document for signature started on <span className="tabular-nums">{document.sendStartedAt === null ? "" : formatCreated(document.sendStartedAt)}</span> UTC and has not been recorded. DocuSeal may already have a signature request for it, and sending again could create a second signature request.
        </Notice>
        <ol style={{ margin: 0, paddingLeft: "1.25rem" }}>
          <li>The send may still be running: it can take several minutes, and it cannot be cleared until the longest possible send has passed. Reload this page first.</li>
          <li>
            In DocuSeal, open {templateName === null ? "the template of this document's PDF" : <>the template named <code>{templateName}</code></>} and look at its submissions.
          </li>
          <li>If it has a signature request for this document, do not send again: this page cannot link an existing request. Delete or archive that request in DocuSeal if you want to start over.</li>
          <li>When DocuSeal has no request for this document, clear the unfinished send below. Then you can send again.</li>
        </ol>
        <ClearSendForm endpoint={ENDPOINTS.clearSend} initial={{}} documentId={document.id} />
      </div>
    </Portlet>
  );
}

function Signers({ signers }: { signers: SigningLink[] }) {
  if (signers.length === 0) {
    return (
      <p className="text-muted" style={{ margin: 0 }}>
        No signers are stored for this document.
      </p>
    );
  }
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Signer</th>
            <th>Email</th>
            <th>Status</th>
            <th>Time (UTC)</th>
            <th>Signing link</th>
          </tr>
        </thead>
        <tbody>
          {signers.map((signer) => {
            const href = safeHref(signer.link);
            return (
              <tr key={signer.role}>
                <td>
                  <strong>{signer.role}</strong>
                  <br />
                  {signer.name}
                </td>
                <td>{signer.email}</td>
                <td>{signer.status === undefined ? "Not refreshed yet" : (SIGNER_STATUS[signer.status] ?? signer.status)}</td>
                <td className="tabular-nums" style={{ whiteSpace: "nowrap" }}>
                  {signerTime(signer.at)}
                </td>
                <td>
                  {href === null ? (
                    <span className="text-muted">Link unavailable</span>
                  ) : (
                    <>
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        Open signing link
                      </a>
                      <div>
                        <code style={{ overflowWrap: "anywhere" }}>{href}</code>
                      </div>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const REFRESHED_TO = new Set(["completed", "declined", "expired"]);

export function SignatureSection({ document, configured, owner, sent, refreshed }: { document: DocumentDetail; configured: boolean; owner: { name: string; email: string }; sent: string | undefined; refreshed: string | undefined }) {
  if (document.status === "generated") {
    if (document.sendStartedAt !== null) return <UnfinishedSend document={document} />;
    if (!document.signature.ready) {
      return (
        <Portlet title="Signature">
          <Notice title="Not ready for signature">{document.signature.reason}</Notice>
        </Portlet>
      );
    }
    if (!configured) {
      return (
        <Portlet title="Signature">
          <NotConfigured />
        </Portlet>
      );
    }
    return (
      <Portlet title="Send for signature">
        {sent === "cleared" ? <Notice tone="ok" title="Unfinished send cleared.">Check that the PDF is still in DocuSeal, then send again.</Notice> : null}
        <ol style={{ margin: "0 0 var(--portlet-pad)", paddingLeft: "1.25rem" }}>
          <li>
            <a href={`/documents/${document.id}/pdf`}>Download PDF</a>.
          </li>
          <li>
            Upload it to DocuSeal without renaming it. The file name must stay <code>{document.pdfName}</code>.
          </li>
          <li>Fill in the two signers below and send. The platform finds the template by that name, places the signature fields and creates the signing links.</li>
        </ol>
        <SignatureForm
          endpoint={ENDPOINTS.send}
          initial={{ values: { ownerName: owner.name, ownerEmail: owner.email, counterpartyName: document.counterpartyName, counterpartyEmail: "", order: "random" }, errors: {} }}
          documentId={document.id}
        />
      </Portlet>
    );
  }

  if (document.status === "draft" || !document.hasSubmission) return null;

  return (
    <Portlet title="Signature">
      <div style={{ display: "grid", gap: "var(--portlet-pad)" }}>
        {sent === "1" ? <Notice tone="ok" title="Sent for signature.">The platform sent no email: share each link below with its signer.</Notice> : null}
        {sent === "already" ? <Notice title="This document was already sent for signature." /> : null}
        {refreshed !== undefined && REFRESHED_TO.has(refreshed) && refreshed === document.status ? <Notice tone="ok" title={refreshedMessage(refreshed)} /> : null}
        <Signers signers={document.signers} />
        <p className="mb-3 text-sm text-muted" style={{ margin: 0 }}>
          Anyone with a link can sign for that signer. Share each link only with its signer.
        </p>
        {document.status === "completed" ? (
          <div className="form-actions">
            <a className="btn btn-primary" href={`/documents/${document.id}/signed-pdf`}>
              Download signed PDF
            </a>
          </div>
        ) : null}
        {document.status === "sent" ? configured ? <RefreshForm endpoint={ENDPOINTS.refresh} initial={{}} documentId={document.id} /> : <NotConfigured /> : null}
      </div>
    </Portlet>
  );
}
