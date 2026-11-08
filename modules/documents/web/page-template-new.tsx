import type { Metadata } from "next";
import { renderTemplateEditPage } from "./template-edit-page.tsx";

export const metadata: Metadata = { title: "New template" };

export default function NewTemplatePage() {
  return renderTemplateEditPage({ idParam: undefined, saved: false, load: () => Promise.reject(new Error("a new template loads nothing")) });
}
