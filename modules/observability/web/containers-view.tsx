import { containerHref, filterContainers, groupByHost, type ContainerFilters, type StateFilter } from "../lib/container-groups.ts";
import { ago } from "../lib/format.ts";
import type { ContainerRow } from "../lib/queries.ts";
import LiveRefresh from "./live-refresh.tsx";
import { Bar, SubNav, withVar } from "./shell.tsx";

const PLATFORM: Record<ContainerRow["platform"], string> = { dokploy: "Dokploy", coolify: "Coolify", docker: "Docker" };
const STATE_LABEL: Record<StateFilter, string> = { live: "All", running: "Running", problems: "Problems", gone: "Gone" };
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

function StateBadge({ box }: { box: ContainerRow }) {
  if (box.gone) return <span className="badge">Gone</span>;
  const tone = box.state === "running" ? "badge badge-success" : box.state === "restarting" || box.state === "dead" ? "badge badge-danger" : "badge badge-warning";
  return <span className={tone}>{box.state[0]!.toUpperCase() + box.state.slice(1)}</span>;
}

function Rows({ rows, now }: { rows: ContainerRow[]; now: number }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr><th scope="col">Container</th><th scope="col">Platform</th><th scope="col">State</th><th scope="col">Image</th><th scope="col">Started</th></tr>
        </thead>
        <tbody>
          {rows.map((box) => (
            <tr key={box.id}>
              <th scope="row">{box.name}<br /><span className="obs-foot">{[box.environment, box.domain].filter((part) => part !== "").join(" · ") || box.service}</span></th>
              <td>{PLATFORM[box.platform]}</td>
              <td><StateBadge box={box} />{box.restarts > 0 ? <><br /><span className="obs-foot">{plural(box.restarts, "restart")}</span></> : null}</td>
              <td className="num">{box.image === "" ? "—" : box.image}</td>
              <td className="num">{box.startedAt === undefined ? "—" : ago(Math.max(0, (now - box.startedAt.getTime()) / 60_000))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Hosts as the heads, projects inside them, containers inside those: closed until asked for, so a big fleet stays readable. */
export default function ContainersView({ containers, filters, now }: { containers: ContainerRow[]; filters: ContainerFilters; now: number }) {
  const live = containers.filter((box) => !box.gone);
  const restarting = live.filter((box) => box.state === "restarting").length;
  const stopped = live.filter((box) => box.state !== "running" && box.state !== "restarting").length;
  const hostNames = [...new Set(containers.map((box) => box.hostName))].sort();
  const hosts = groupByHost(filterContainers(containers, filters));
  const searching = filters.q !== "" || filters.state === "problems" || filters.state === "gone";
  return (
    <>
      <Bar title="Containers" subtitle="What runs on each host, as Dokploy, Coolify and Docker report it. Open a host to see its projects.">
        <LiveRefresh />
        <SubNav current="containers" firing={0} />
      </Bar>
      {containers.length === 0 ? <p className="obs-empty">No containers reported yet.</p> : (
        <>
          <dl className="stats" aria-label="Container summary">
            <div className="stat" style={withVar("--stat-tone", "var(--success)")}><dt className="stat-label">Running</dt><dd className="stat-value">{live.length - restarting - stopped}</dd></div>
            <div className="stat" style={withVar("--stat-tone", restarting > 0 ? "var(--danger)" : "var(--success)")}><dt className="stat-label">Restarting</dt><dd className="stat-value">{restarting}</dd></div>
            <div className="stat" style={withVar("--stat-tone", stopped > 0 ? "var(--warning)" : "var(--success)")}><dt className="stat-label">Stopped</dt><dd className="stat-value">{stopped}</dd></div>
            <div className="stat"><dt className="stat-label">Hosts</dt><dd className="stat-value">{hostNames.length}</dd></div>
          </dl>
          <div className="obs-filters">
            <nav className="seg" aria-label="Host">
              <a href={containerHref(filters, { host: null })} aria-current={filters.host === null ? "page" : undefined}>All hosts</a>
              {hostNames.map((name) => <a key={name} href={containerHref(filters, { host: name })} aria-current={filters.host === name ? "page" : undefined}>{name}</a>)}
            </nav>
            <nav className="seg" aria-label="State">
              {(Object.keys(STATE_LABEL) as StateFilter[]).map((state) => <a key={state} href={containerHref(filters, { state })} aria-current={filters.state === state ? "page" : undefined}>{STATE_LABEL[state]}</a>)}
            </nav>
            <form method="get" action="/observability/containers" className="obs-search" role="search">
              {filters.host === null ? null : <input type="hidden" name="host" value={filters.host} />}
              {filters.state === "live" ? null : <input type="hidden" name="state" value={filters.state} />}
              <input className="input" type="search" name="q" defaultValue={filters.q} placeholder="Search name, project, image, domain" aria-label="Search containers" />
              <button type="submit" className="btn btn-sm">Search</button>
            </form>
          </div>
          {hosts.length === 0 ? <p className="obs-empty">No containers match these filters. <a href="/observability/containers">Clear them</a>.</p> : hosts.map((host) => (
            <details key={host.hostName} className="card obs-tree" open={searching || filters.host !== null}>
              <summary className="obs-tree-head">
                <span className="obs-tree-name">{host.hostName}</span>
                <span className="obs-badges">
                  {host.platforms.map((platform) => <span key={platform} className="badge">{PLATFORM[platform]}</span>)}
                  {host.problems > 0 ? <span className="badge badge-danger">{plural(host.problems, "problem")}</span> : null}
                </span>
                <span className="obs-foot">{plural(host.total, "container")} · {host.running} running</span>
              </summary>
              {host.projects.map((project) => (
                <details key={project.name} className="obs-tree-project" open={searching || project.problems > 0}>
                  <summary className="obs-tree-sub">
                    <strong>{project.name === "" ? "No project" : project.name}</strong>
                    <span className="obs-foot">{plural(project.rows.length, "container")}</span>
                    {project.problems > 0 ? <span className="badge badge-danger">{plural(project.problems, "problem")}</span> : null}
                  </summary>
                  <Rows rows={project.rows} now={now} />
                </details>
              ))}
            </details>
          ))}
        </>
      )}
    </>
  );
}
