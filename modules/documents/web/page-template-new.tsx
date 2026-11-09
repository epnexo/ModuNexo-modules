import type { Metadata } from "next";
import { renderTemplateEditPage } from "./template-edit-page.tsx";

export const metadata: Metadata = { title: "New template" };

export default async function NewTemplatePage({ searchParams }: { searchParams: Promise<{ import_error?: string | string[] }> }) {
  const { import_error } = await searchParams;
  return renderTemplateEditPage({
    idParam: undefined,
    saved: false,
    importError: Array.isArray(import_error) ? import_error[0] : import_error,
    load: () => Promise.reject(new Error("a new template loads nothing")),
  });
}
