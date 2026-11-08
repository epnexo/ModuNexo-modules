import { getPool } from "@epnexo/core/pool";
import type { Metadata } from "next";
import { loadTemplateEditData } from "./loaders.ts";
import { renderTemplateEditPage } from "./template-edit-page.tsx";

export const metadata: Metadata = { title: "Template" };

export default async function EditTemplatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string | string[] }> }) {
  const { id } = await params;
  const { saved } = await searchParams;
  return renderTemplateEditPage({ idParam: id, saved: saved === "1", load: (templateId) => loadTemplateEditData(getPool(), templateId) });
}
