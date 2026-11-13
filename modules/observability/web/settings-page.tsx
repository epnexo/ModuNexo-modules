import CollectorSetup from "./collector-setup.tsx";

export const metadata = { title: "Collector setup" };

export default function ObservabilitySettingsPage() {
  return <div className="flex flex-col gap-6"><header><h1 className="text-2xl font-semibold tracking-tight">Collector setup</h1><p className="mt-1 max-w-2xl text-sm text-muted">Issue collector access, store the internal CA, and generate the host configuration without keeping tokens in the platform.</p></header><CollectorSetup /></div>;
}
