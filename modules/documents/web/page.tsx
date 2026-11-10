import { getDb } from "@modunexo/sdk";
import type { Metadata } from "next";
import { listDocuments } from "./queries.ts";
import { renderRegistryPage } from "./registry-page.tsx";
import "./documents.css";

export const metadata: Metadata = { title: "Documents" };

export default function DocumentsPage() {
  return renderRegistryPage(() => listDocuments(getDb("documents")));
}
