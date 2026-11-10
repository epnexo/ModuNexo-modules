import Link from "next/link";
import { notFound } from "next/navigation";
import { fieldsForTemplate } from "../src/create-document.ts";
import type { Profile } from "../src/profile.ts";
import { parseTemplateId } from "../src/template-rules.ts";
import type { Template } from "../src/template-store.ts";
import { ENDPOINTS } from "./endpoints.ts";
import { Notice, Portlet } from "./components.tsx";
import { DocumentForm } from "./forms.tsx";
import { logFailure } from "./log.ts";
import { PageBar } from "./nav.tsx";
import { Unavailable } from "./page-state.tsx";

export interface NewDocumentData {
  /** Active templates, for the picker. */
  templates: Template[];
  /** The template named in the URL (archived or not), or null when none was asked for or it does not exist. */
  chosen: Template | null;
  profile: Profile;
}

const KIND_LABELS: Record<string, string> = { nda: "NDA", contract: "Contract", proposal: "Proposal", other: "Other" };

function Picker({ templates }: { templates: Template[] }) {
  if (templates.length === 0) {
    return (
      <p className="text-muted" style={{ margin: 0 }}>
        There are no templates to create a document from. <Link href="/documents/templates/new">Create a template</Link> first.
      </p>
    );
  }
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Template</th>
            <th>Kind</th>
            <th>Numbered</th>
          </tr>
        </thead>
        <tbody>
          {templates.map((template) => (
            <tr key={template.id}>
              <td>
                <Link href={`/documents/new?template=${template.id}`}>{template.name}</Link>
              </td>
              <td>{KIND_LABELS[template.kind] ?? template.kind}</td>
              <td className="tabular-nums">{template.refPrefix}-YYYY-NNN</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * `/documents/new`. With no `template` in the URL it lists the templates to choose from; with one, the form for
 * that template. The choice lives in the URL, so the page is a plain GET and works without JavaScript.
 */
export async function renderNewDocumentPage({
  templateParam,
  load,
  now = () => new Date(),
}: {
  templateParam: string | undefined;
  load: (templateId: number | null) => Promise<NewDocumentData>;
  /** The clock a date variable starts from. */
  now?: () => Date;
}) {
  const requested = templateParam === undefined ? null : parseTemplateId(templateParam);
  if (templateParam !== undefined && requested === null) notFound();

  let data: NewDocumentData;
  try {
    data = await load(requested);
  } catch (error) {
    logFailure("could not load the new document page", error);
    return (
      <div>
        <PageBar title="New document" current="documents" />
        <div className="dc-page">
          <Unavailable title="Templates are unavailable" error={error} />
        </div>
      </div>
    );
  }

  if (requested === null) {
    return (
      <div>
        <PageBar title="New document" description="Choose the template the document is made from." current="documents" />
        <div className="dc-page">
          <Portlet title="Templates">
            <Picker templates={data.templates} />
          </Portlet>
        </div>
      </div>
    );
  }

  const template = data.chosen;
  if (template === null) notFound();
  if (template.archivedAt !== null) {
    return (
      <div>
        <PageBar title="New document" current="documents" />
        <div className="dc-page">
          <Notice title="This template is archived">
            Documents cannot be made from it. <Link href="/documents/new">Choose another template</Link>
          </Notice>
        </div>
      </div>
    );
  }

  const { fields } = fieldsForTemplate(template.bodyHtml, template.counterpartyMarker, data.profile, template.variables, now());
  return (
    <div>
      <PageBar title="New document" description={`${template.name}. Numbered ${template.refPrefix}-YYYY-NNN when created.`} current="documents" />
      <div className="dc-page">
        <Portlet title={template.name}>
          <DocumentForm endpoint={ENDPOINTS.createDocument} initial={{ values: {}, errors: {} }} templateId={template.id} fields={fields} profileKeys={Object.keys(data.profile)} />
        </Portlet>
      </div>
    </div>
  );
}
