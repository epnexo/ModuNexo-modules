import { getDb } from "@modunexo/sdk";
import type { Metadata } from "next";
import { loadProfileValues } from "./loaders.ts";
import { renderSettingsPage } from "./settings-page.tsx";

export const metadata: Metadata = { title: "Owner profile" };

export default function SettingsPage() {
  return renderSettingsPage(() => loadProfileValues(getDb("documents")));
}
