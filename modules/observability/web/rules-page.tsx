import { loadRules } from "../lib/queries.ts";
import RulesView from "./rules-view.tsx";
import "./observability.css";

export const metadata = { title: "Alert rules" };

export default async function RulesPage() {
  return <div className="obs"><RulesView rules={await loadRules()} /></div>;
}
