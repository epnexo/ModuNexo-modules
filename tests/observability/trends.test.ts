import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTrends, compareWeeks, findSpikes, forecastFull, type DayPoint, type HourPoint } from "../../modules/observability/lib/trends.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.UTC(2026, 10, 15, 12);
const today = Date.UTC(2026, 10, 15);
/** One point per complete day, the last one being yesterday. */
const days = (values: number[]): DayPoint[] => values.map((avg, index) => ({ t: today - (values.length - index) * DAY, avg }));
/** One point per hour, the last one being the previous full hour. */
const hours = (values: Array<[number, number]>): HourPoint[] => values.map(([avg, max], index) => ({ t: Math.floor(now / HOUR) * HOUR - (values.length - index) * HOUR, avg, max }));

describe("comparing this week with the last one", () => {
  it("compares the average of the last seven complete days with the seven before", () => {
    const result = compareWeeks(days([...Array(7).fill(10), ...Array(7).fill(20)]), now);
    assert.deepEqual(result, { current: 20, previous: 10, change: 10, percent: 100 });
  });

  it("says nothing until each week has at least four days", () => {
    assert.equal(compareWeeks(days([...Array(3).fill(10), ...Array(7).fill(20)]), now), null);
    assert.equal(compareWeeks(days(Array(7).fill(20)), now), null);
    assert.notEqual(compareWeeks(days([...Array(4).fill(10), ...Array(7).fill(20)]), now), null);
  });

  it("leaves today out because its day is not over", () => {
    const base = days([...Array(7).fill(10), ...Array(7).fill(20)]);
    assert.deepEqual(compareWeeks([...base, { t: today, avg: 99 }], now)?.current, 20);
  });

  it("gives no percentage when the last week averaged zero", () => {
    const result = compareWeeks(days([...Array(7).fill(0), ...Array(7).fill(5)]), now);
    assert.equal(result?.percent, null);
    assert.equal(result?.change, 5);
  });
});

describe("forecasting a full disk", () => {
  it("projects the days left from the growth per day", () => {
    const result = forecastFull(days([50, 52, 54, 56, 58, 60]), now);
    assert.equal(result.state, "filling");
    if (result.state !== "filling") return;
    assert.ok(Math.abs(result.perDay - 2) < 1e-9);
    assert.ok(Math.abs(result.daysLeft - 20) < 1e-9);
    assert.ok(Math.abs(result.fullOn - (now + 20 * DAY)) < 1);
  });

  it("asks for more days when there are fewer than three", () => {
    assert.deepEqual(forecastFull(days([50, 52]), now), { state: "unknown", daysOfData: 2, needed: 3 });
  });

  it("calls a flat or shrinking disk stable", () => {
    assert.equal(forecastFull(days([60, 60, 60, 60]), now).state, "stable");
    assert.equal(forecastFull(days([70, 68, 66, 64]), now).state, "stable");
  });

  it("calls a disk that would take more than a year to fill stable", () => {
    assert.equal(forecastFull(days([50, 50.1, 50.2, 50.3]), now).state, "stable");
  });

  it("reports a disk at the ceiling as full now", () => {
    const result = forecastFull(days([96, 98, 100]), now);
    assert.equal(result.state === "filling" ? result.daysLeft : -1, 0);
  });

  it("uses only the last two weeks", () => {
    const old = Array(10).fill(90);
    const result = forecastFull(days([...old, ...Array(14).fill(40)]), now);
    assert.equal(result.state, "stable");
  });
});

describe("finding spikes", () => {
  const steady = (count: number): Array<[number, number]> => Array.from({ length: count }, () => [10, 12]);

  it("flags an hour whose peak is far above the usual level", () => {
    const [spike, ...rest] = findSpikes("cpuPercent", hours([...steady(24), [30, 80]]), now);
    assert.equal(rest.length, 0);
    assert.equal(spike?.value, 80);
    assert.equal(spike?.usual, 10);
    assert.equal(spike?.metric, "cpuPercent");
  });

  it("ignores a rise smaller than the least jump that matters for the metric", () => {
    assert.deepEqual(findSpikes("cpuPercent", hours([...steady(24), [15, 20]]), now), []);
  });

  it("ignores a rise on a noisy baseline", () => {
    const noisy: Array<[number, number]> = Array.from({ length: 24 }, (_, index) => (index % 2 === 0 ? [10, 10] : [60, 60]));
    assert.deepEqual(findSpikes("cpuPercent", hours([...noisy, [70, 70]]), now), []);
  });

  it("needs half a day of history before it judges", () => {
    assert.deepEqual(findSpikes("cpuPercent", hours([...steady(11), [30, 80]]), now), []);
  });

  it("only looks at the metrics it knows how to judge", () => {
    assert.deepEqual(findSpikes("diskUsedPercent", hours([...steady(24), [30, 80]]), now), []);
  });

  it("reports only the last day, newest first", () => {
    const values: Array<[number, number]> = [...steady(20), [30, 80], ...steady(30), [30, 70], ...steady(5), [30, 90]];
    const found = findSpikes("cpuPercent", hours(values), now);
    assert.deepEqual(found.map((spike) => spike.value), [90, 70]);
  });
});

describe("a host's trends", () => {
  it("gathers the comparisons, the disk forecast and the spikes", () => {
    const daily = {
      cpuPercent: days([...Array(7).fill(10), ...Array(7).fill(20)]),
      diskUsedPercent: days([50, 52, 54, 56]),
      tempCelsius: days([40, 41]),
    };
    const hourly = { cpuPercent: hours([...Array.from({ length: 24 }, (): [number, number] => [10, 12]), [30, 80]]) };
    const trends = buildTrends(daily, hourly, now);
    assert.deepEqual(trends.weeks.map((week) => week.metric), ["cpuPercent"]);
    assert.equal(trends.disk.state, "filling");
    assert.equal(trends.spikes.length, 1);
  });

  it("keeps the disk forecast unknown when the host has no disk history", () => {
    assert.deepEqual(buildTrends({}, {}, now).disk, { state: "unknown", daysOfData: 0, needed: 3 });
  });
});
