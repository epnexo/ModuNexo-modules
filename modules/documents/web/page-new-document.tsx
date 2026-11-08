import { getPool } from "@epnexo/core/pool";
import type { Metadata } from "next";
import { loadNewDocumentData } from "./loaders.ts";
import { renderNewDocumentPage } from "./new-document-page.tsx";

export const metadata: Metadata = { title: "New document" };

export default async function NewDocumentPage({ searchParams }: { searchParams: Promise<{ template?: string | string[] }> }) {
  const { template } = await searchParams;
  return renderNewDocumentPage({ templateParam: typeof template === "string" ? template : undefined, load: (id) => loadNewDocumentData(getPool(), id) });
}
