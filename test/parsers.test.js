import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";

import criterion from "../runners/criterion.js";
import gungraun from "../runners/gungraun.js";
import { renderMarkdown, escapeName } from "../lib/report.js";

const fixture = (name) =>
  fs.readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

test("criterion: parses the critcmp table", () => {
  const rows = criterion.parse(fixture("critcmp-output.txt"));

  assert.equal(rows.length, 7);

  const first = rows[0];
  assert.equal(first.name, "character module");
  assert.equal(first.base, "22.2±0.41ms");
  assert.equal(first.changes, "21.6±0.53ms");
  assert.equal(first.difference, "-2.70%");
  assert.equal(first.significant, true);
  assert.equal(first.faster, true);
});

test("criterion: marks regressions and bolds the base column", () => {
  const rows = criterion.parse(fixture("critcmp-output.txt"));
  const regressed = rows.find((r) => r.name === "regressed bench");

  assert.equal(regressed.difference, "+25.00%");
  assert.equal(regressed.significant, true);
  assert.equal(regressed.faster, false);
});

test("criterion: handles a benchmark missing from the PR", () => {
  const rows = criterion.parse(fixture("critcmp-output.txt"));
  const onlyBase = rows.find((r) => r.name === "only_in_base");

  assert.equal(onlyBase.base, "5.0±0.10ms");
  assert.equal(onlyBase.changes, "N/A");
  assert.equal(onlyBase.difference, "N/A");
  assert.equal(onlyBase.significant, false);
});

test("criterion: overlapping error bars are not significant", () => {
  const rows = criterion.parse(fixture("critcmp-output.txt"));
  const micro = rows.find((r) => r.name === "micro bench");

  assert.equal(micro.difference, "0.00%");
  assert.equal(micro.significant, false);
});

test("criterion: normalises units across ns/µs/ms", () => {
  assert.equal(criterion.convertDurToSeconds(1, "s"), 1);
  assert.equal(criterion.convertDurToSeconds(1000, "ms"), 1);
  assert.equal(criterion.convertDurToSeconds(1000000, "µs"), 1);
  assert.equal(criterion.convertDurToSeconds(1000000000, "ns"), 1);
});

test("gungraun: Both is [new, old] — base and PR are not swapped", () => {
  const rows = gungraun.parse(fixture("gungraun-output.jsonl"));
  const ir = rows.find(
    (r) => r.name === "my_bench::my_group::bench_fast Instructions"
  );

  // Left (new/PR) = 214, Right (old/base) = 280.
  assert.equal(ir.base, "280");
  assert.equal(ir.changes, "214");
  assert.equal(ir.difference, "-23.57%");
  assert.equal(ir.significant, true);
  assert.equal(ir.faster, true);
});

test("gungraun: reports Instructions and Estimated Cycles per benchmark", () => {
  const rows = gungraun.parse(fixture("gungraun-output.jsonl"));
  const names = rows
    .filter((r) => r.name.startsWith("my_bench::my_group::bench_fast"))
    .map((r) => r.name);

  assert.deepEqual(names, [
    "my_bench::my_group::bench_fast Instructions",
    "my_bench::my_group::bench_fast Estimated Cycles",
  ]);
});

test("gungraun: a regression is signed and flagged", () => {
  const rows = gungraun.parse(fixture("gungraun-output.jsonl"));
  const ir = rows.find(
    (r) => r.name === "my_bench::my_group::bench_slow Instructions"
  );

  assert.equal(ir.base, "800");
  assert.equal(ir.changes, "900");
  assert.equal(ir.difference, "+12.50%");
  assert.equal(ir.significant, true);
  assert.equal(ir.faster, false);
});

test("gungraun: Left-only means the benchmark is new in the PR", () => {
  const rows = gungraun.parse(fixture("gungraun-output.jsonl"));
  const ir = rows.find(
    (r) => r.name === "my_bench::my_group::bench_new Instructions"
  );

  assert.equal(ir.base, "N/A");
  assert.equal(ir.changes, "150");
  assert.equal(ir.difference, "N/A");
  assert.equal(ir.significant, false);
});

test("gungraun: Right-only means the benchmark was removed", () => {
  const rows = gungraun.parse(fixture("gungraun-output.jsonl"));
  const ir = rows.find(
    (r) => r.name === "my_bench::my_group::bench_gone Instructions"
  );

  assert.equal(ir.base, "99");
  assert.equal(ir.changes, "N/A");
  assert.equal(ir.difference, "N/A");
});

test("gungraun: an unchanged benchmark is not marked significant", () => {
  const rows = gungraun.parse(fixture("gungraun-output.jsonl"));
  const ir = rows.find((r) =>
    r.name.startsWith("my_bench::my_group::bench_param")
  );

  assert.equal(ir.difference, "0.00%");
  assert.equal(ir.significant, false);
});

test("gungraun: benchmark name includes id and details", () => {
  const rows = gungraun.parse(fixture("gungraun-output.jsonl"));
  const ir = rows.find((r) => r.name.includes("bench_param"));

  assert.equal(
    ir.name,
    "my_bench::my_group::bench_param case_1 (nth of vec![2, -2]) Instructions"
  );
});

test("gungraun: diff_pct arrives as a string and is coerced", () => {
  const raw = JSON.parse(fixture("gungraun-output.jsonl").split("\n")[0]);
  const diff = raw.profiles[0].summaries.total.summary.Callgrind.Ir.diffs;

  assert.equal(typeof diff.diff_pct, "string");

  const rows = gungraun.parse(fixture("gungraun-output.jsonl"));
  assert.ok(!rows[0].difference.includes("NaN"));
});

test("gungraun: parses the upstream summary fixture", () => {
  const rows = gungraun.parse(fixture("gungraun-summary-v6.json"));

  assert.ok(rows.length > 0);
  const ir = rows.find((r) => r.name.endsWith("Instructions"));
  assert.equal(ir.base, "56");
  assert.equal(ir.changes, "56");
});

test("gungraun: splitEitherOrBoth handles every variant", () => {
  assert.deepEqual(
    gungraun.splitEitherOrBoth({ Both: [{ Int: 1 }, { Int: 2 }] }),
    {
      changes: 1,
      base: 2,
    }
  );
  assert.deepEqual(gungraun.splitEitherOrBoth({ Left: { Int: 5 } }), {
    changes: 5,
    base: null,
  });
  assert.deepEqual(gungraun.splitEitherOrBoth({ Right: { Float: 1.5 } }), {
    changes: null,
    base: 1.5,
  });
});

// The v7 fixture is real gungraun 0.20.0 output from a PR run with
// `--callgrind-limits='ir=5%'`: one benchmark is unchanged, one regressed,
// one got faster, and one is new in the PR.
const findV7Row = (name) =>
  gungraun
    .parse(fixture("gungraun-output-v7.jsonl"))
    .find((r) => r.name === name);

test("gungraun v7: reports Instructions and Estimated Cycles per benchmark", () => {
  const names = gungraun
    .parse(fixture("gungraun-output-v7.jsonl"))
    .map((r) => r.name);

  assert.deepEqual(names, [
    "demo_bench::my_group::bench_same Instructions",
    "demo_bench::my_group::bench_same Estimated Cycles",
    "demo_bench::my_group::bench_fib short (10) Instructions",
    "demo_bench::my_group::bench_fib short (10) Estimated Cycles",
    "demo_bench::my_group::bench_sum Instructions",
    "demo_bench::my_group::bench_sum Estimated Cycles",
    "demo_bench::my_group::bench_added Instructions",
    "demo_bench::my_group::bench_added Estimated Cycles",
  ]);
});

test("gungraun v7: new is the PR and old is the base", () => {
  const ir = findV7Row("demo_bench::my_group::bench_sum Instructions");

  assert.equal(ir.base, "4,014");
  assert.equal(ir.changes, "13");
  assert.equal(ir.difference, "-99.68%");
  assert.equal(ir.significant, true);
  assert.equal(ir.faster, true);
});

test("gungraun v7: a regression is signed and flagged", () => {
  const ir = findV7Row(
    "demo_bench::my_group::bench_fib short (10) Instructions"
  );
  const cycles = findV7Row(
    "demo_bench::my_group::bench_fib short (10) Estimated Cycles"
  );

  assert.equal(ir.base, "1,802");
  assert.equal(ir.changes, "2,158");
  assert.equal(ir.difference, "+19.76%");
  assert.equal(ir.significant, true);
  assert.equal(ir.faster, false);
  assert.equal(cycles.difference, "+19.92%");
});

test("gungraun v7: an unchanged benchmark is not marked significant", () => {
  const ir = findV7Row("demo_bench::my_group::bench_same Instructions");

  assert.equal(ir.base, "8");
  assert.equal(ir.changes, "8");
  assert.equal(ir.difference, "0.00%");
  assert.equal(ir.significant, false);
});

test("gungraun v7: new-only means the benchmark is new in the PR", () => {
  const ir = findV7Row("demo_bench::my_group::bench_added Instructions");

  assert.equal(ir.base, "N/A");
  assert.equal(ir.changes, "13");
  assert.equal(ir.difference, "N/A");
  assert.equal(ir.significant, false);
});

test("gungraun v7: old-only means the benchmark was removed", () => {
  const line = JSON.stringify({
    version: "7",
    module_path: "b::g::gone",
    profiles: [
      {
        tool: "Callgrind",
        data: {
          parts: [],
          total: { metrics: { Ir: { values: { old: 99 } } }, regressions: [] },
        },
      },
    ],
  });
  const [ir] = gungraun.parse(line);

  assert.equal(ir.name, "b::g::gone Instructions");
  assert.equal(ir.base, "99");
  assert.equal(ir.changes, "N/A");
  assert.equal(ir.difference, "N/A");
});

test("gungraun v7: a regression flags the row even with no value change", () => {
  const line = JSON.stringify({
    version: "7",
    module_path: "b::g::flat",
    profiles: [
      {
        tool: "Callgrind",
        data: {
          parts: [],
          total: {
            metrics: {
              Ir: {
                change: { diff_pct: "0", factor: "1" },
                values: { new: 5, old: 5 },
              },
            },
            regressions: [{ Soft: {} }],
          },
        },
      },
    ],
  });
  const [ir] = gungraun.parse(line);

  assert.equal(ir.difference, "0.00%");
  assert.equal(ir.significant, true);
});

test("gungraun v7: a v6 layout under version 7 yields no metrics", () => {
  const raw = JSON.parse(fixture("gungraun-summary-v6.json"));
  raw.version = "7";

  assert.throws(
    () => gungraun.parse(JSON.stringify(raw)),
    /no comparable metrics were found/
  );
});

test("gungraun: splitNewOld handles every variant", () => {
  assert.deepEqual(gungraun.splitNewOld({ new: 1, old: 2 }), {
    changes: 1,
    base: 2,
  });
  assert.deepEqual(gungraun.splitNewOld({ new: 5 }), {
    changes: 5,
    base: null,
  });
  assert.deepEqual(gungraun.splitNewOld({ old: 1.5 }), {
    changes: null,
    base: 1.5,
  });
  assert.deepEqual(gungraun.splitNewOld(undefined), {
    changes: null,
    base: null,
  });
  assert.deepEqual(gungraun.splitNewOld({ new: "7" }), {
    changes: null,
    base: null,
  });
});

test("gungraun: rejects an unsupported summary version", () => {
  const line = JSON.stringify({ version: 99, profiles: [] });

  assert.throws(
    () => gungraun.parse(line),
    /Unsupported gungraun summary version '99'.*version\(s\) 6, 7/
  );
});

test("gungraun: errors clearly when there is no output", () => {
  assert.throws(() => gungraun.parse(""), /No benchmark results found/);
});

test("criterion: rendered markdown is unchanged from the pre-refactor output", () => {
  const rows = criterion.parse(fixture("critcmp-output.txt"));

  assert.equal(
    renderMarkdown(rows, "abc1234def5678", criterion.displayName),
    fixture("criterion-expected.md")
  );
});

test("report: the heading names the harness", () => {
  const rows = gungraun.parse(fixture("gungraun-output.jsonl"));
  const md = renderMarkdown(rows, "abc1234def5678", gungraun.displayName);

  assert.ok(md.startsWith("## Gungraun Benchmark for abc1234\n"));
});

test("report: the heading omits the harness when none is given", () => {
  const md = renderMarkdown([], "abc1234def5678");

  assert.ok(md.startsWith("## Benchmark for abc1234\n"));
});

test("report: pipes in benchmark names are escaped", () => {
  assert.equal(escapeName("a | b"), "a \\| b");
});

test("report: significant rows bold the winning column", () => {
  const md = renderMarkdown(
    [
      {
        name: "x",
        base: "10",
        changes: "5",
        difference: "-50.00%",
        significant: true,
        faster: true,
      },
    ],
    "abc1234def"
  );

  assert.ok(md.includes("| x | 10 | **5** | **-50.00%** |"));
  assert.ok(md.includes("## Benchmark for abc1234"));
});
