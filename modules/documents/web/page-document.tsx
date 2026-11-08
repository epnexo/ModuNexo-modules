import { getDb } from "@modunexo/sdk";
import type { Metadata } from "next";
import { docusealConfigured } from "../src/docuseal-client.ts";
import { getDocument } from "../src/document-store.ts";
import { getProfile } from "../src/profile-store.ts";
import { ownerSignerDefaults } from "../src/signature-rules.ts";
import { renderDocumentPage } from "./document-page.tsx";

export const metadata: Metadata = { title: "Document" };

export default async function DocumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string | string[]; sent?: string | string[]; refreshed?: string | string[] }> }) {
  const { id } = await params;
  const { created, sent, refreshed } = await searchParams;
  return renderDocumentPage({
    idParam: id,
    created: created === "1",
    sent: typeof sent === "string" ? sent : undefined,
    refreshed: typeof refreshed === "string" ? refreshed : undefined,
    configured: docusealConfigured(),
    loadOwner: async () => ownerSignerDefaults(await getProfile(getDb("documents"))),
    load: (documentId) => getDocument(getDb("documents"), documentId),
  });
}
