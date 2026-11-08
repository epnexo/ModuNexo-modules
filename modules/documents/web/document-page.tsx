import Link from "next/link";
import { notFound } from "next/navigation";
import type { DocumentDetail } from "../src/document-store.ts";
import { parseDocumentId, resolveVariable } from "../src/document-rules.ts";
import type { VariableSettings } from "../src/variables.ts";
import { Notice, Portlet } from "./components.tsx";
import { logFailure } from "./log.ts";
import { SignatureSection } from "./signature-section.tsx";
import { PageBar } from "./nav.tsx";
import { Unavailable } from "./page-state.tsx";
import type { DocumentStatus } from "./queries.ts";
import { formatCreated, statusBadge } from "./registry.ts";

/**
 * The values of a document. With `settings`, each is labelled the way the new-document form labelled it (the template's current
 * label, else the readable marker name) and the marker follows in small text; without, the name is shown as stored.
 */
function Values({ values, settings }: { values: Record<string, string>; settings?: VariableSettings }) {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        None.
      </p>
    );
  }
  return (
    <dl className="details">
      {entries.map(([name, value]) => (
        <div key={name}>
          <dt>
            {settings ? (
              <>
                {resolveVariable(name, Object.hasOwn(settings, name) ? settings[name] : undefined, new Date(0)).label} <small>{name}</small>
              </>
            ) : (
              name
            )}
          </dt>
          <dd style={{ whiteSpace: "pre-line" }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * `/documents/[id]`. A bad or unknown id is a 404; a database failure is a notice. Stored values reach the page as
 * escaped text only: the document itself is never rendered as HTML, the PDF is the only rendered form.
 */
export async function renderDocumentPage({
  idParam,
  created,
  sent,
  refreshed,
  configured,
  loadOwner,
  load,
}: {
  idParam: string;
  created: boolean;
  /** The `sent` query value after a send or a clear: `1`, `already` or `cleared`. Anything else shows nothing. */
  sent?: string | undefined;
  /** The `refreshed` query value after a refresh that moved the document out of `sent`: the status it reached. Anything else shows nothing. */
  refreshed?: string | undefined;
  /** Whether `DOCUSEAL_URL` and `DOCUSEAL_API_TOKEN` are set. */
  configured: boolean;
  /** The owner's name and email for the signer form; read only when the form is shown. */
  loadOwner: () => Promise<{ name: string; email: string }>;
  load: (id: number) => Promise<DocumentDetail | null>;
}) {
  const id = parseDocumentId(idParam);
  if (id === null) notFound();

  let document: DocumentDetail | null;
  try {
    document = await load(id);
  } catch (error) {
    logFailure("could not load the document", error);
    return (
      <div>
        <PageBar title="Document" current="documents" />
        <div className="page-body">
          <Unavailable title="The document is unavailable" error={error} />
        </div>
      </div>
    );
  }
  if (document === null) notFound();

  let owner = { name: "", email: "" };
  if (document.status === "generated" && document.signature.ready && configured && document.sendStartedAt === null) {
    try {
      owner = await loadOwner();
    } catch (error) {
      logFailure("could not load the owner's signer details", error);
    }
  }

  const badge = statusBadge(document.status as DocumentStatus);
  return (
    <div>
      <PageBar title={document.ref} description={document.title} current="documents" />
      <div className="page-body">
        {created ? <Notice tone="ok" title="Document created." /> : null}
        <Portlet title="Document">
          <dl className="details">
            <div>
              <dt>Reference</dt>
              <dd className="num">{document.ref}</dd>
            </div>
            <div>
              <dt>Title</dt>
              <dd>{document.title}</dd>
            </div>
            <div>
              <dt>Counterparty</dt>
              <dd>{document.counterpartyName}</dd>
            </div>
            <div>
              <dt>Template</dt>
              <dd>{document.templateName}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <span className={badge.className}>{badge.label}</span>
              </dd>
            </div>
            <div>
              <dt>Created (UTC)</dt>
              <dd className="num">{formatCreated(document.createdAt)}</dd>
            </div>
            {document.completedAt !== null ? (
              <div>
                <dt>Completed (UTC)</dt>
                <dd className="num">{formatCreated(document.completedAt)}</dd>
              </div>
            ) : null}
            {document.pages !== null ? (
              <div>
                <dt>Pages</dt>
                <dd className="num">{document.pages}</dd>
              </div>
            ) : null}
          </dl>
          <div className="form-actions" style={{ marginTop: "var(--portlet-pad)" }}>
            {document.hasPdf ? (
              <>
                <a className="btn primary" href={`/documents/${document.id}/pdf`}>
                  Download PDF
                </a>
                <a className="btn" href={`/documents/${document.id}/pdf?inline=1`} target="_blank" rel="noopener noreferrer" aria-label={`Preview ${document.ref} PDF (opens in a new tab)`}>
                  Preview
                </a>
              </>
            ) : (
              <span className="muted">This document has no PDF.</span>
            )}
            <Link className="btn" href="/documents">
              Back to documents
            </Link>
          </div>
        </Portlet>
        <SignatureSection document={document} configured={configured} owner={owner} sent={sent} refreshed={refreshed} />
        <Portlet title="Values entered">
          <Values values={document.values} settings={document.templateVariables} />
        </Portlet>
        <Portlet title="Values from the profile">
          <Values values={document.profile} />
        </Portlet>
      </div>
    </div>
  );
}
