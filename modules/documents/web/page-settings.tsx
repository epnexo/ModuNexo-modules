import { getPool } from "@epnexo/core/pool";
import type { Metadata } from "next";
import { loadProfileValues } from "./loaders.ts";
import { renderSettingsPage } from "./settings-page.tsx";

export const metadata: Metadata = { title: "Owner profile" };

export default function SettingsPage() {
  return renderSettingsPage(() => loadProfileValues(getPool()));
}
