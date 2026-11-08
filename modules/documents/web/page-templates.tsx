import { getDb } from "@modunexo/sdk";
import type { Metadata } from "next";
import { loadTemplatesData } from "./loaders.ts";
import { renderTemplatesPage } from "./templates-page.tsx";

export const metadata: Metadata = { title: "Templates" };

type Param = string | string[] | undefined;

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ imported?: Param; profile?: Param; import_error?: Param }> }) {
  const { imported, profile, import_error } = await searchParams;
  const one = (value: Param) => (Array.isArray(value) ? value[0] : value);
  return renderTemplatesPage(() => loadTemplatesData(getDb("documents")), { imported: one(imported), profile: one(profile), error: one(import_error) });
}
