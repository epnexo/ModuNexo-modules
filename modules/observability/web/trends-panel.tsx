import { formatMetric, formatTime, formatValue, metricLabel, metricUnit } from "../lib/format.ts";
import type { DiskForecast, HostTrends } from "../lib/trends.ts";

const days = (count: number): string => `${count} ${count === 1 ? "day" : "days"}`;

function DiskCard({ disk }: { disk: DiskForecast }) {
  const body = (() => {
    if (disk.state === "unknown") return <p className="obs-empty">Needs {days(disk.needed)} of disk history to forecast; {disk.daysOfData === 0 ? "none yet" : `${days(disk.daysOfData)} so far`}.</p>;
    if (disk.state === "stable") return <p>Stable: the disk is not growing fast enough to fill within a year.</p>;
    if (disk.daysLeft === 0) return <p><strong>The disk is full.</strong></p>;
    return (
      <>
        <p className="obs-chart-now">{disk.daysLeft < 1 ? "Less than a day" : `About ${days(Math.round(disk.daysLeft))}`}</p>
        <p>Until the disk is full, around {new Date(disk.fullOn).toISOString().slice(0, 10)}. It grows {formatValue("percent", disk.perDay)} a day.</p>
      </>
    );
  })();
  return (
    <section className="card" aria-label="Disk forecast">
      <div className="obs-chart-head"><h3>Disk forecast</h3></div>
      {body}
    </section>
  );
}

/** Week over week, the disk forecast and the hours that stood out, from the host's rollups. */
export default function TrendsPanel({ trends }: { trends: HostTrends }) {
  return (
    <section className="obs-section" aria-labelledby="trends-heading">
      <h2 id="trends-heading">Trends</h2>
      <div className="obs-charts">
        <DiskCard disk={trends.disk} />
        <section className="card" aria-label="This week against last week">
          <div className="obs-chart-head"><h3>This week against last week</h3></div>
          {trends.weeks.length === 0 ? <p className="obs-empty">Needs four days of history in each of the two weeks to compare.</p> : (
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th scope="col">Metric</th><th scope="col">Last week</th><th scope="col">This week</th><th scope="col">Change</th></tr></thead>
                <tbody>
                  {trends.weeks.map((week) => (
                    <tr key={week.metric}>
                      <th scope="row">{metricLabel(week.metric)}</th>
                      <td className="num">{formatMetric(week.metric, week.previous)}</td>
                      <td className="num">{formatMetric(week.metric, week.current)}</td>
                      <td className="num">{Math.abs(week.change) < 1e-9 ? "—" : `${week.change > 0 ? "▲" : "▼"} ${week.percent === null ? formatValue(metricUnit(week.metric), Math.abs(week.change)) : `${Math.abs(week.percent).toFixed(0)}%`}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="card" aria-label="Spikes in the last day">
          <div className="obs-chart-head"><h3>Spikes in the last 24 hours</h3></div>
          {trends.spikes.length === 0 ? <p className="obs-empty">No hour stood out from the day before it.</p> : (
            <ul>
              {trends.spikes.map((spike) => <li key={`${spike.metric}-${spike.t}`}>{metricLabel(spike.metric)} peaked at {formatMetric(spike.metric, spike.value)} in the hour of {formatTime(new Date(spike.t))}, usually {formatMetric(spike.metric, spike.usual)}.</li>)}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
