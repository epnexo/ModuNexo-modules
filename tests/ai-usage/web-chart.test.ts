import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  areaPath,
  axisTicks,
  barFractions,
  cumulative,
  dayReadout,
  fillDays,
  linePath,
  keyAction,
  linePoints,
  nearestIndex,
  nextActive,
  niceCeiling,
  plotBox,
  stackLayout,
  stackShares,
  thinLabels,
  topWithOther,
} from "../../modules/ai-usage/web/chart.ts";

describe("niceCeiling", () => {
  it("rounds up to 1, 2, 2.5, 5 or 10 times a power of ten", () => {
    assert.equal(niceCeiling(0), 1);
    assert.equal(niceCeiling(87), 100);
    assert.equal(niceCeiling(101), 200);
    assert.equal(niceCeiling(230), 250);
    assert.equal(niceCeiling(310), 500);
    assert.equal(niceCeiling(620), 1000);
    assert.equal(niceCeiling(100), 100);
    assert.equal(niceCeiling(118_000_000), 200_000_000);
  });
});

describe("fillDays", () => {
  it("returns every UTC day in the range, with null where nothing was recorded", () => {
    const days = fillDays([{ day: "2026-10-01", value: 5 }, { day: "2026-10-04", value: 9 }], "2026-10-01", "2026-10-05");
    assert.deepEqual(days, [
      { day: "2026-10-01", value: 5 },
      { day: "2026-10-02", value: null },
      { day: "2026-10-03", value: null },
      { day: "2026-10-04", value: 9 },
      { day: "2026-10-05", value: null },
    ]);
  });

  it("crosses month boundaries and handles a single day", () => {
    assert.deepEqual(
      fillDays([], "2026-09-29", "2026-10-02").map((d) => d.day),
      ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"],
    );
    assert.equal(fillDays([], "2026-10-01", "2026-10-01").length, 1);
  });

  it("returns nothing when the range is reversed", () => {
    assert.deepEqual(fillDays([], "2026-10-05", "2026-10-01"), []);
  });
});

describe("stackShares", () => {
  it("returns shares of the known parts and treats unknown parts as absent", () => {
    assert.deepEqual(stackShares([75, 25, null]), [0.75, 0.25, null]);
  });

  it("returns zero shares when every part is zero or unknown", () => {
    assert.deepEqual(stackShares([0, null]), [0, null]);
  });
});

describe("axisTicks", () => {
  it("picks a round ceiling and round ticks, at most five intervals", () => {
    assert.deepEqual(axisTicks(230), { max: 250, ticks: [0, 50, 100, 150, 200, 250] });
    assert.deepEqual(axisTicks(87), { max: 100, ticks: [0, 20, 40, 60, 80, 100] });
    assert.deepEqual(axisTicks(118_000_000), { max: 200_000_000, ticks: [0, 50_000_000, 100_000_000, 150_000_000, 200_000_000] });
  });

  it("still gives an axis for no data", () => {
    assert.deepEqual(axisTicks(0), { max: 1, ticks: [0, 1] });
  });

  it("never needs more than six ticks", () => {
    for (const max of [1, 3, 7, 12, 45, 99, 101, 640, 1234, 9_999_999]) {
      const { ticks, max: ceiling } = axisTicks(max);
      assert.ok(ticks.length <= 6, `${max}: ${ticks.length} ticks`);
      assert.ok(ceiling >= max);
      assert.equal(ticks.at(-1), ceiling);
    }
  });
});

describe("thinLabels", () => {
  it("prints every label when they fit", () => {
    assert.deepEqual(thinLabels(4, 100, 40, 8), [0, 1, 2, 3]);
  });

  it("prints every nth label so neighbors keep the minimum gap", () => {
    // 36 wide slots, 48 wide labels, 8 gap: one label every 2 slots.
    assert.deepEqual(thinLabels(7, 36, 48, 8), [0, 2, 4, 6]);
  });

  it("drops a last label that would crowd the previous one", () => {
    // Step 3 over 8 slots: 0, 3, 6; index 7 is not a multiple, so it never appears.
    assert.deepEqual(thinLabels(8, 20, 48, 8), [0, 3, 6]);
  });

  it("handles empty and single-day ranges", () => {
    assert.deepEqual(thinLabels(0, 10, 40, 8), []);
    assert.deepEqual(thinLabels(1, 10, 40, 8), [0]);
  });
});

describe("cumulative", () => {
  it("keeps a running total and treats null as nothing recorded", () => {
    assert.deepEqual(cumulative([5, null, 10, 0, 1]), [5, 5, 15, 15, 16]);
  });

  it("returns nothing for no days", () => {
    assert.deepEqual(cumulative([]), []);
  });
});

describe("stackLayout", () => {
  const box = { width: 100, height: 300, max: 300, gap: 2, maxBar: 24 };

  it("stacks parts from the baseline in input order and trims the gap from every segment above the first", () => {
    const [bar] = stackLayout([[100, 200]], { ...box, width: 50 });
    assert.deepEqual(bar!.segments, [
      { index: 0, value: 100, y: 200, height: 100 },
      { index: 1, value: 200, y: 0, height: 198 },
    ]);
  });

  it("skips null and zero parts but keeps each part's index", () => {
    const [bar] = stackLayout([[null, 0, 150]], { ...box, width: 50 });
    assert.deepEqual(bar!.segments, [{ index: 2, value: 150, y: 150, height: 150 }]);
  });

  it("keeps a tiny segment at least one unit tall", () => {
    const [bar] = stackLayout([[150, 1]], { ...box, width: 50 });
    assert.equal(bar!.segments[1]!.height, 1);
    assert.equal(bar!.segments[1]!.y, 149);
  });

  it("centers bars in their slot and caps their width", () => {
    const bars = stackLayout([[10], [10]], box);
    assert.equal(bars[0]!.width, 24);
    assert.equal(bars[0]!.x, 13);
    assert.equal(bars[1]!.x, 63);
  });

  it("shrinks bars below the cap when slots are narrow", () => {
    const bars = stackLayout(Array.from({ length: 10 }, () => [10]), box);
    assert.equal(bars[0]!.width, 7);
    assert.equal(bars[0]!.x, 1.5);
  });

  it("gives a day with no usage no segments", () => {
    const [bar] = stackLayout([[null, null]], box);
    assert.deepEqual(bar!.segments, []);
  });
});

describe("linePoints, linePath and areaPath", () => {
  const box = { width: 100, height: 50, max: 100 };

  it("puts points at the slot centers, scaled to the box", () => {
    assert.deepEqual(linePoints([0, 50, 100, 100], box), [
      { x: 12.5, y: 50 },
      { x: 37.5, y: 25 },
      { x: 62.5, y: 0 },
      { x: 87.5, y: 0 },
    ]);
  });

  it("builds a polyline path and a closed area path", () => {
    const points = [
      { x: 10, y: 40 },
      { x: 20, y: 10 },
    ];
    assert.equal(linePath(points), "M10 40L20 10");
    assert.equal(areaPath(points, 50), "M10 40L20 10L20 50L10 50Z");
  });

  it("returns an empty path for no points", () => {
    assert.equal(linePath([]), "");
    assert.equal(areaPath([], 50), "");
  });
});

describe("nearestIndex", () => {
  it("snaps a pointer x to the slot it is in", () => {
    assert.equal(nearestIndex(60, 4, 50, 100), 0);
    assert.equal(nearestIndex(80, 4, 50, 100), 1);
    assert.equal(nearestIndex(149, 4, 50, 100), 3);
  });

  it("clamps pointers outside the plot", () => {
    assert.equal(nearestIndex(0, 4, 50, 100), 0);
    assert.equal(nearestIndex(900, 4, 50, 100), 3);
  });

  it("returns -1 when there is nothing to point at", () => {
    assert.equal(nearestIndex(10, 0, 0, 100), -1);
  });
});

describe("barFractions", () => {
  it("scales to the longest bar and keeps unknown parts unknown", () => {
    assert.deepEqual(barFractions([50, 100, null, 0]), [0.5, 1, null, 0]);
  });

  it("keeps a visible sliver for a tiny non-zero value", () => {
    const [tiny] = barFractions([1, 1_000_000]);
    assert.equal(tiny, 0.005);
  });

  it("returns zero lengths when nothing is known", () => {
    assert.deepEqual(barFractions([null, 0]), [null, 0]);
  });
});

describe("topWithOther", () => {
  const items = [
    { label: "a", amount: 50 },
    { label: "b", amount: 30 },
    { label: "c", amount: 15 },
    { label: "d", amount: 5 },
  ];

  it("folds the tail into one other item", () => {
    assert.deepEqual(
      topWithOther(items, 2, (n) => `${n} other models`),
      [
        { label: "a", amount: 50, other: false },
        { label: "b", amount: 30, other: false },
        { label: "2 other models", amount: 20, other: true },
      ],
    );
  });

  it("folds nothing when everything fits", () => {
    assert.equal(topWithOther(items, 4, (n) => `${n}`).length, 4);
    assert.ok(topWithOther(items, 4, (n) => `${n}`).every((item) => !item.other));
  });
});

describe("dayReadout", () => {
  const fmt = { day: (day: string) => `D ${day}`, value: (value: number) => `${value}!` };

  it("lists every tool in order, says no usage for a quiet tool, and totals the day", () => {
    assert.deepEqual(
      dayReadout("2026-10-01", [{ name: "Claude Code", value: 30 }, { name: "Codex", value: null }, { name: "Pi", value: 12 }], fmt),
      {
        title: "D 2026-10-01",
        total: 42,
        rows: [
          { name: "Claude Code", value: 30, text: "30!" },
          { name: "Codex", value: null, text: "no usage" },
          { name: "Pi", value: 12, text: "12!" },
        ],
      },
    );
  });
});

describe("nextActive", () => {
  const pointer = (index: number) => ({ type: "at", index }) as const;
  const key = (name: string) => {
    const handled = keyAction(name);
    assert.ok(handled !== null, `${name} should be handled`);
    return handled.action;
  };

  it("moves to the day under the pointer and clears on leave", () => {
    assert.equal(nextActive(null, 5, pointer(3)), 3);
    assert.equal(nextActive(1, 5, pointer(4)), 4);
    assert.equal(nextActive(3, 5, { type: "leave" }), null);
    assert.equal(nextActive(null, 5, { type: "leave" }), null);
  });

  it("steps with the arrows from the current day", () => {
    assert.equal(nextActive(2, 5, key("ArrowRight")), 3);
    assert.equal(nextActive(2, 5, key("ArrowLeft")), 1);
  });

  it("clamps at the first and last day instead of wrapping", () => {
    assert.equal(nextActive(4, 5, key("ArrowRight")), 4);
    assert.equal(nextActive(0, 5, key("ArrowLeft")), 0);
  });

  it("starts from the first day on ArrowRight and from the last on ArrowLeft when nothing is active", () => {
    assert.equal(nextActive(null, 5, key("ArrowRight")), 0);
    assert.equal(nextActive(null, 5, key("ArrowLeft")), 4);
  });

  it("jumps with Home and End, from any state", () => {
    assert.equal(nextActive(null, 5, key("Home")), 0);
    assert.equal(nextActive(3, 5, key("Home")), 0);
    assert.equal(nextActive(null, 5, key("End")), 4);
    assert.equal(nextActive(1, 5, key("End")), 4);
  });

  it("clears on Escape", () => {
    assert.equal(nextActive(2, 5, key("Escape")), null);
    assert.equal(nextActive(null, 5, key("Escape")), null);
  });

  it("works with a single day", () => {
    assert.equal(nextActive(null, 1, key("ArrowRight")), 0);
    assert.equal(nextActive(null, 1, key("ArrowLeft")), 0);
    assert.equal(nextActive(0, 1, key("ArrowRight")), 0);
    assert.equal(nextActive(0, 1, key("ArrowLeft")), 0);
    assert.equal(nextActive(null, 1, key("End")), 0);
    assert.equal(nextActive(null, 1, pointer(0)), 0);
  });

  it("never has an active day when there are no days", () => {
    for (const action of [pointer(-1), pointer(0), key("ArrowRight"), key("ArrowLeft"), key("Home"), key("End"), key("Escape"), { type: "leave" } as const]) {
      assert.equal(nextActive(null, 0, action), null);
      assert.equal(nextActive(0, 0, action), null);
    }
  });

  it("ignores a pointer index outside the days, including the -1 of an empty series", () => {
    assert.equal(nextActive(2, 5, pointer(-1)), null);
    assert.equal(nextActive(2, 5, pointer(5)), null);
    assert.equal(nextActive(2, 5, pointer(1.5)), null);
  });

  it("pulls a stale active day back into range when days shrink", () => {
    assert.equal(nextActive(9, 3, key("ArrowLeft")), 1);
    assert.equal(nextActive(9, 3, key("ArrowRight")), 2);
  });

  it("always lands inside 0..count-1 or on null", () => {
    const actions = ["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].map((name) => key(name));
    for (const count of [0, 1, 2, 7]) {
      for (const start of [null, 0, 1, 6, 50]) {
        for (const action of actions) {
          const next = nextActive(start, count, action);
          assert.ok(next === null || (Number.isInteger(next) && next >= 0 && next < count), `${count} ${start} ${action.type}: ${next}`);
        }
      }
    }
  });
});

describe("keyAction", () => {
  it("handles and prevents the default of the arrows, Home and End", () => {
    for (const name of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      assert.equal(keyAction(name)?.preventDefault, true, name);
    }
  });

  it("handles Escape without preventing its default", () => {
    assert.deepEqual(keyAction("Escape"), { action: { type: "escape" }, preventDefault: false });
  });

  it("leaves every other key alone", () => {
    for (const name of ["Tab", "Enter", " ", "ArrowUp", "ArrowDown", "PageDown", "a", "Shift"]) {
      assert.equal(keyAction(name), null, name);
    }
  });
});

describe("plotBox", () => {
  const margin = { left: 52, top: 10, right: 20, bottom: 28 };

  it("subtracts the margins from the box", () => {
    assert.deepEqual(plotBox(1000, 320, margin), { width: 928, height: 282 });
  });

  it("never goes negative when the box is narrower or shorter than its margins", () => {
    assert.deepEqual(plotBox(60, 20, margin), { width: 0, height: 0 });
    assert.deepEqual(plotBox(1, 1, margin), { width: 0, height: 0 });
  });

  it("keeps every mark non-negative when the plot is empty", () => {
    const plot = plotBox(60, 20, margin);
    const bars = stackLayout([[10, 20], [5, null]], { ...plot, max: 100, gap: 2, maxBar: 24 });
    for (const bar of bars) {
      assert.ok(bar.width >= 0);
      for (const segment of bar.segments) assert.ok(segment.height >= 0 && segment.y >= 0, JSON.stringify(segment));
    }
    for (const point of linePoints([1, 2], { ...plot, max: 10 })) assert.ok(point.y >= 0 && Number.isFinite(point.x));
  });
});
