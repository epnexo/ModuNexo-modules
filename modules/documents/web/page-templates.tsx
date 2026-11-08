import { getPool } from "@epnexo/core/pool";
import type { Metadata } from "next";
import { loadTemplatesData } from "./loaders.ts";
import { renderTemplatesPage } from "./templates-page.tsx";

export const metadata: Metadata = { title: "Templates" };

export default function TemplatesPage() {
  return renderTemplatesPage(() => loadTemplatesData(getPool()));
}
