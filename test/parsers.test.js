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

test("gungraun: rejects an unsupported summary version", () => {
  const line = JSON.stringify({ version: 99, profiles: [] });

  assert.throws(
    () => gungraun.parse(line),
    /Unsupported gungraun summary version/
  );
});

test("gungraun: errors clearly when there is no output", () => {
  assert.throws(() => gungraun.parse(""), /No benchmark results found/);
});

test("criterion: rendered markdown is unchanged from the pre-refactor output", () => {
  const rows = criterion.parse(fixture("critcmp-output.txt"));

  assert.equal(
    renderMarkdown(rows, "abc1234def5678"),
    fixture("criterion-expected.md")
  );
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
