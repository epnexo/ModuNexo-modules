import { loadAlerts, loadRules } from "../lib/queries.ts";
import AlertsView from "./alerts-view.tsx";
import "./observability.css";

export const metadata = { title: "Alerts" };

export default async function AlertsPage() {
  const [{ firing, history }, rules] = await Promise.all([loadAlerts(), loadRules()]);
  return <div className="obs"><AlertsView firing={firing} history={history} rules={rules} /></div>;
}
