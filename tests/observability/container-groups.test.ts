import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { containerHref, filterContainers, groupByHost, parseContainerFilters, type ContainerFilters } from "../../modules/observability/lib/container-groups.ts";
import type { ContainerRow } from "../../modules/observability/lib/queries.ts";
import ContainersView from "../../modules/observability/web/containers-view.tsx";

const row = (fields: Partial<ContainerRow> & { id: number }): ContainerRow => ({ hostName: "pi", name: `c-${fields.id}`, platform: "dokploy", project: "Monitoring", environment: "production", service: "svc", image: "img:1", state: "running", restarts: 0, startedAt: undefined, domain: "", gone: false, ...fields });
const all: ContainerRow[] = [
  row({ id: 1, name: "prometheus-1", project: "Monitoring" }),
  row({ id: 2, name: "grafana-1", project: "Monitoring", state: "restarting", restarts: 4 }),
  row({ id: 3, name: "db-1", project: "CRM", domain: "crm.example.com" }),
  row({ id: 4, name: "n8n", hostName: "vps-home", platform: "coolify", project: "n8n" }),
  row({ id: 5, name: "old-1", hostName: "vps-home", platform: "coolify", project: "n8n", gone: true }),
];
const none: ContainerFilters = { host: null, state: "live", q: "" };

describe("container filters", () => {
  it("reads host, state and search from the query and ignores anything else", () => {
    assert.deepEqual(parseContainerFilters({ host: "pi", state: "problems", q: " grafana " }), { host: "pi", state: "problems", q: "grafana" });
    assert.deepEqual(parseContainerFilters({ host: ["a", "b"], state: "weird", q: undefined }), none);
  });

  it("hides containers the platform stopped listing unless asked, and filters by state", () => {
    assert.deepEqual(filterContainers(all, none).map((r) => r.id), [1, 2, 3, 4]);
    assert.deepEqual(filterContainers(all, { ...none, state: "problems" }).map((r) => r.id), [2]);
    assert.deepEqual(filterContainers(all, { ...none, state: "running" }).map((r) => r.id), [1, 3, 4]);
    assert.deepEqual(filterContainers(all, { ...none, state: "gone" }).map((r) => r.id), [5]);
  });

  it("filters by host and by text over name, project, image, service and domain", () => {
    assert.deepEqual(filterContainers(all, { ...none, host: "vps-home" }).map((r) => r.id), [4]);
    assert.deepEqual(filterContainers(all, { ...none, q: "CRM.example" }).map((r) => r.id), [3]);
    assert.deepEqual(filterContainers(all, { ...none, q: "monitoring" }).map((r) => r.id), [1, 2]);
  });

  it("builds links that keep the other filters and drop defaults", () => {
    assert.equal(containerHref({ host: "pi", state: "problems", q: "x" }, { state: "live" }), "/observability/containers?host=pi&q=x");
    assert.equal(containerHref(none, {}), "/observability/containers");
    assert.equal(containerHref({ ...none, host: "pi" }, { host: null }), "/observability/containers");
  });
});

describe("grouping by host", () => {
  it("nests projects under hosts with their counts, problems first", () => {
    const hosts = groupByHost(filterContainers(all, none));
    assert.deepEqual(hosts.map((h) => h.hostName), ["pi", "vps-home"]);
    const pi = hosts[0]!;
    assert.deepEqual([pi.total, pi.running, pi.problems], [3, 2, 1]);
    assert.deepEqual(pi.platforms, ["dokploy"]);
    assert.deepEqual(pi.projects.map((p) => [p.name, p.rows.length, p.problems]), [["Monitoring", 2, 1], ["CRM", 1, 0]]);
  });
});

describe("the containers view", () => {
  const render = (filters: ContainerFilters, now = Date.UTC(2026, 10, 15)) => renderToStaticMarkup(createElement(ContainersView, { containers: all, filters, now }));

  it("starts collapsed: a header per host and no host open, only the project with a problem", () => {
    const html = render(none);
    assert.match(html, /<summary[^>]*>.*pi.*3 containers/s);
    assert.match(html, /<summary[^>]*>.*vps-home/s);
    assert.doesNotMatch(html, /<details class="card obs-tree" open/);
    assert.equal((html.match(/<details[^>]* open/g) ?? []).length, 1);
  });

  it("opens the chosen host, and opens projects that have problems", () => {
    const html = render({ ...none, host: "pi" });
    assert.equal((html.match(/<details[^>]* open/g) ?? []).length, 2);
    assert.match(html, /aria-current="page"[^>]*>pi</);
  });

  it("opens everything while searching and says when nothing matches", () => {
    assert.doesNotMatch(render({ ...none, q: "db" }), /<details(?![^>]* open)/);
    assert.match(render({ ...none, q: "zzz" }), /No containers match/);
  });

  it("keeps the summary counts and offers a search box that keeps the other filters", () => {
    const html = render({ ...none, host: "pi" });
    assert.match(html, /Running<\/dt><dd class="stat-value">3/);
    assert.match(html, /<form[^>]*method="get"/);
    assert.match(html, /name="host" value="pi"/);
  });
});
