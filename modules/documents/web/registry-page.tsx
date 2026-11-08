import Link from "next/link";
import { RegistryBody } from "./components.tsx";
import { logFailure } from "./log.ts";
import { PageBar } from "./nav.tsx";
import { Unavailable } from "./page-state.tsx";
import type { DocumentRow } from "./queries.ts";

const DESCRIPTION = "Every document created from a template, newest first. Times are UTC.";

/** The registry page for whatever `load` returns, so a test can render it with a stub instead of the database. */
export async function renderRegistryPage(load: () => Promise<DocumentRow[]>) {
  let rows: DocumentRow[];
  try {
    rows = await load();
  } catch (error) {
    logFailure("could not load the page", error);
    return (
      <div>
        <PageBar title="Documents" description={DESCRIPTION} current="documents" />
        <div className="page-body">
          <Unavailable title="Documents are unavailable" error={error} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageBar
        title="Documents"
        description={DESCRIPTION}
        current="documents"
        actions={
          <Link className="btn primary" href="/documents/new">
            New document
          </Link>
        }
      />
      <div className="page-body">
        <RegistryBody rows={rows} />
      </div>
    </div>
  );
}
