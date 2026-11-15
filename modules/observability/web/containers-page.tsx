import { parseContainerFilters } from "../lib/container-groups.ts";
import { loadContainers } from "../lib/queries.ts";
import ContainersView from "./containers-view.tsx";
import "./observability.css";

export const metadata = { title: "Containers" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ContainersPage({ searchParams }: { searchParams: SearchParams }) {
  const filters = parseContainerFilters(await searchParams);
  return <div className="obs"><ContainersView containers={await loadContainers()} filters={filters} now={Date.now()} /></div>;
}
