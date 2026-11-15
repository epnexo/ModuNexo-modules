import { ago } from "../lib/format.ts";
import type { ContainerRow } from "../lib/queries.ts";
import LiveRefresh from "./live-refresh.tsx";
import { Bar, SubNav, withVar } from "./shell.tsx";

const PLATFORM: Record<ContainerRow["platform"], string> = { dokploy: "Dokploy", coolify: "Coolify", docker: "Docker" };

function StateBadge({ box }: { box: ContainerRow }) {
  if (box.gone) return <span className="badge">Gone</span>;
  const tone = box.state === "running" ? "badge badge-success" : box.state === "restarting" || box.state === "dead" ? "badge badge-danger" : "badge badge-warning";
  return <span className={tone}>{box.state[0]!.toUpperCase() + box.state.slice(1)}</span>;
}

/** Containers grouped by project: where each runs, which platform manages it, its image, state and restarts. */
export default function ContainersView({ containers, now }: { containers: ContainerRow[]; now: number }) {
  const live = containers.filter((box) => !box.gone);
  const count = (state: ContainerRow["state"]) => live.filter((box) => box.state === state).length;
  const restarting = count("restarting");
  const stopped = live.filter((box) => box.state !== "running" && box.state !== "restarting").length;
  const projects = [...new Set(containers.map((box) => box.project))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  return (
    <>
      <Bar title="Containers" subtitle="What runs on each host, grouped by project, as Dokploy, Coolify and Docker report it.">
        <LiveRefresh />
        <SubNav current="containers" firing={0} />
      </Bar>
      {containers.length === 0 ? <p className="obs-empty">No containers reported yet.</p> : (
        <>
          <dl className="stats" aria-label="Container summary">
            <div className="stat" style={withVar("--stat-tone", "var(--success)")}><dt className="stat-label">Running</dt><dd className="stat-value">{count("running")}</dd></div>
            <div className="stat" style={withVar("--stat-tone", restarting > 0 ? "var(--danger)" : "var(--success)")}><dt className="stat-label">Restarting</dt><dd className="stat-value">{restarting}</dd></div>
            <div className="stat" style={withVar("--stat-tone", stopped > 0 ? "var(--warning)" : "var(--success)")}><dt className="stat-label">Stopped</dt><dd className="stat-value">{stopped}</dd></div>
            <div className="stat"><dt className="stat-label">Projects</dt><dd className="stat-value">{projects.filter((project) => project !== "").length}</dd></div>
          </dl>
          {projects.map((project) => (
            <section key={project} className="card" style={{ padding: 0 }} aria-label={project === "" ? "No project" : project}>
              <h2 className="obs-group">{project === "" ? "No project" : project}</h2>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr><th scope="col">Container</th><th scope="col">Host</th><th scope="col">Platform</th><th scope="col">State</th><th scope="col">Image</th><th scope="col">Started</th></tr>
                  </thead>
                  <tbody>
                    {containers.filter((box) => box.project === project).map((box) => (
                      <tr key={box.id}>
                        <th scope="row">{box.name}<br /><span className="obs-foot">{[box.environment, box.domain].filter((part) => part !== "").join(" · ") || box.service}</span></th>
                        <td>{box.hostName}</td>
                        <td>{PLATFORM[box.platform]}</td>
                        <td><StateBadge box={box} />{box.restarts > 0 ? <><br /><span className="obs-foot">{box.restarts} {box.restarts === 1 ? "restart" : "restarts"}</span></> : null}</td>
                        <td className="num">{box.image === "" ? "—" : box.image}</td>
                        <td className="num">{box.startedAt === undefined ? "—" : ago(Math.max(0, (now - box.startedAt.getTime()) / 60_000))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </>
      )}
    </>
  );
}
