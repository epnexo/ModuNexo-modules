import { loadFleet } from "../lib/queries.ts";
import FleetView from "./fleet-view.tsx";
import "./observability.css";

export const metadata = { title: "Observability" };

export default async function ObservabilityPage() {
  const fleet = await loadFleet();
  return <div className="obs"><FleetView fleet={fleet} now={Date.now()} /></div>;
}
