import * as exec from "@actions/exec";
import * as core from "@actions/core";

// Metrics surfaced in the PR comment, in display order. These are the two
// headline metrics gungraun's own terminal output leads with.
const REPORTED_METRICS = [
  ["Ir", "Instructions"],
  ["EstimatedCycles", "Estimated Cycles"],
];

// Summary schema versions this parser understands. gungraun-summary currently
// ships v6 structures; v7 exists in the schema directory and is layout
// compatible for the fields we read.
const SUPPORTED_SUMMARY_VERSIONS = ["6", "7"];

const BASELINE_NAME = "base";
const CHANGES_NAME = "changes";

/**
 * Metric values are tagged: `{ Int: 56 }` or `{ Float: 0.0 }`.
 */
function metricValue(metric) {
  if (metric === null || typeof metric !== "object") {
    return null;
  }

  if (typeof metric.Int === "number") {
    return metric.Int;
  }

  if (typeof metric.Float === "number") {
    return metric.Float;
  }

  return null;
}

/**
 * `metrics` is an EitherOrBoth. Per gungraun's convention the *new* run is on
 * the left and the *old* (baseline) run on the right, so `Both: [new, old]`.
 * A benchmark added in the PR yields `Left` only; one removed yields `Right`.
 */
function splitEitherOrBoth(metrics) {
  if (!metrics || typeof metrics !== "object") {
    return { changes: null, base: null };
  }

  if (Array.isArray(metrics.Both)) {
    return {
      changes: metricValue(metrics.Both[0]),
      base: metricValue(metrics.Both[1]),
    };
  }

  if ("Left" in metrics) {
    return { changes: metricValue(metrics.Left), base: null };
  }

  if ("Right" in metrics) {
    return { changes: null, base: metricValue(metrics.Right) };
  }

  return { changes: null, base: null };
}

function formatMetric(value) {
  if (value === null) {
    return "N/A";
  }

  // Rates and miss ratios come back as floats; counts stay integral.
  return Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : value.toFixed(4);
}

/**
 * Builds the display name. `module_path` is already the fully qualified
 * `bench_file::group::bench`; `id` and `details` disambiguate parameterised runs.
 */
function benchmarkName(summary) {
  let name = summary.module_path || summary.function_name || "unknown";

  if (summary.id) {
    name += ` ${summary.id}`;
  }

  if (summary.details) {
    name += ` ${summary.details}`;
  }

  return name.replace(/\s+/g, " ").trim();
}

function findProfile(summary) {
  const profiles = Array.isArray(summary.profiles) ? summary.profiles : [];

  // Callgrind is the default tool and the only one reporting Ir/EstimatedCycles.
  return (
    profiles.find((profile) => profile.tool === "Callgrind") || profiles[0]
  );
}

/**
 * Parses gungraun's JSONL output (`--output-format=json`): one BenchmarkSummary
 * object per line on stdout.
 */
function parse(stdout) {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));

  if (lines.length === 0) {
    throw new Error(
      "No benchmark results found in gungraun output. Ensure the benchmarks ran " +
        "and that `--output-format=json` is supported by your gungraun version."
    );
  }

  const rows = [];

  for (const line of lines) {
    let summary;
    try {
      summary = JSON.parse(line);
    } catch (err) {
      core.debug(`Skipping unparsable gungraun output line: ${line}`);
      continue;
    }

    const version = String(summary.version);
    if (!SUPPORTED_SUMMARY_VERSIONS.includes(version)) {
      throw new Error(
        `Unsupported gungraun summary version '${version}'. This action supports ` +
          `version(s) ${SUPPORTED_SUMMARY_VERSIONS.join(
            ", "
          )}. Please open an issue.`
      );
    }

    const profile = findProfile(summary);
    if (!profile) {
      continue;
    }

    const total = profile.summaries && profile.summaries.total;
    if (!total || !total.summary) {
      continue;
    }

    // ToolMetricSummary is an externally tagged enum keyed by tool name.
    const metricsByName = total.summary[profile.tool];
    if (!metricsByName) {
      continue;
    }

    const hasRegression =
      Array.isArray(total.regressions) && total.regressions.length > 0;
    const name = benchmarkName(summary);

    for (const [key, label] of REPORTED_METRICS) {
      const entry = metricsByName[key];
      if (!entry) {
        continue;
      }

      const { base, changes } = splitEitherOrBoth(entry.metrics);
      if (base === null && changes === null) {
        continue;
      }

      let difference = "N/A";
      let significant = false;
      let faster = false;

      if (base !== null && changes !== null) {
        // diff_pct and factor are serialised as strings, not numbers.
        const diffPct =
          entry.diffs && entry.diffs.diff_pct !== undefined
            ? Number(entry.diffs.diff_pct)
            : base === 0
            ? 0
            : -(1 - changes / base) * 100;

        if (Number.isFinite(diffPct)) {
          difference = (diffPct > 0 ? "+" : "") + diffPct.toFixed(2) + "%";

          // Instruction counts are deterministic, so any real delta counts.
          // Bold only what gungraun itself flags, or a non-zero change.
          if (changes !== base) {
            significant = true;
            faster = changes < base;
          }
        }
      }

      rows.push({
        name: `${name} ${label}`,
        base: formatMetric(base),
        changes: formatMetric(changes),
        difference,
        significant: significant || hasRegression,
        faster,
      });
    }
  }

  if (rows.length === 0) {
    throw new Error(
      "gungraun produced output but no comparable metrics were found. " +
        "Check that the benchmarks use the Callgrind tool."
    );
  }

  return rows;
}

export default {
  name: "gungraun",
  displayName: "Gungraun",

  // gungraun compares against a saved baseline during the run itself, so the
  // base branch must be benchmarked *first*.
  order: "base-first",

  async prepare() {
    if (process.platform !== "linux") {
      throw new Error(
        `gungraun requires Linux (Valgrind is unavailable on '${process.platform}'). ` +
          "Run this action on a Linux runner such as ubuntu-latest."
      );
    }

    const missing = [];

    for (const [tool, args] of [
      ["gungraun-runner", ["--version"]],
      ["valgrind", ["--version"]],
    ]) {
      const code = await exec
        .exec(tool, args, {
          ignoreReturnCode: true,
          silent: true,
        })
        .catch(() => 1);

      if (code !== 0) {
        missing.push(tool);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Missing required tool(s) for the gungraun harness: ${missing.join(
          ", "
        )}. ` +
          "Add the official setup action to your workflow before this step:\n\n" +
          "    - uses: gungraun/setup-gungraun@v1\n\n" +
          "See https://github.com/gungraun/setup-gungraun for options."
      );
    }
  },

  benchArgsForBase() {
    return [`--save-baseline=${BASELINE_NAME}`];
  },

  // The PR run compares against the saved base baseline and emits the diff.
  benchArgsForChanges() {
    return [
      `--baseline=${BASELINE_NAME}`,
      `--save-baseline=${CHANGES_NAME}`,
      "--output-format=json",
    ];
  },

  // The second run's stdout already contains the comparison; no extra tool.
  comparisonFromSecondRun: true,

  parse,

  // exported for tests
  splitEitherOrBoth,
  benchmarkName,
  metricValue,
};
