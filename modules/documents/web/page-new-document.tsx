import { getDb } from "@modunexo/sdk";
import type { Metadata } from "next";
import { loadNewDocumentData } from "./loaders.ts";
import { renderNewDocumentPage } from "./new-document-page.tsx";
import "./documents.css";

export const metadata: Metadata = { title: "New document" };

export default async function NewDocumentPage({ searchParams }: { searchParams: Promise<{ template?: string | string[] }> }) {
  const { template } = await searchParams;
  return renderNewDocumentPage({ templateParam: typeof template === "string" ? template : undefined, load: (id) => loadNewDocumentData(getDb("documents"), id) });
}
