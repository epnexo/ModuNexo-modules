import CollectorTokens from "./collector-tokens.tsx";

export const metadata = { title: "Collector tokens" };

export default function ObservabilitySettingsPage() {
  return <div className="flex flex-col gap-6"><header><h1 className="text-2xl font-semibold tracking-tight">Collector tokens</h1><p className="mt-1 max-w-2xl text-sm text-muted">Issue and revoke the tokens that let a collector or the forwarder send samples to this module. A token is shown once, when it is created.</p></header><CollectorTokens /></div>;
}
