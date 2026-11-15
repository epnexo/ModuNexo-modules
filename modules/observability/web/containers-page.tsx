import { loadContainers } from "../lib/queries.ts";
import ContainersView from "./containers-view.tsx";
import "./observability.css";

export const metadata = { title: "Containers" };

export default async function ContainersPage() {
  return <div className="obs"><ContainersView containers={await loadContainers()} now={Date.now()} /></div>;
}
