import { getPool } from "@epnexo/core/pool";
import type { Metadata } from "next";
import { listDocuments } from "./queries.ts";
import { renderRegistryPage } from "./registry-page.tsx";

export const metadata: Metadata = { title: "Documents" };

export default function DocumentsPage() {
  return renderRegistryPage(() => listDocuments(getPool()));
}
