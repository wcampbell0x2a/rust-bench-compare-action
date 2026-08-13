import { inspect } from "node:util";
import * as exec from "@actions/exec";
import * as core from "@actions/core";
import * as github from "@actions/github";

import { renderMarkdown, renderTable } from "./lib/report.js";
import criterion from "./runners/criterion.js";
import gungraun from "./runners/gungraun.js";

const context = github.context;

const RUNNERS = {
  criterion,
  gungraun,
};

function getRunner(harness) {
  const runner = RUNNERS[harness];

  if (!runner) {
    throw new Error(
      `Unknown harness '${harness}'. Supported values: ${Object.keys(
        RUNNERS
      ).join(", ")}.`
    );
  }

  return runner;
}

function getBooleanInput(name, fallback) {
  const raw = core.getInput(name);

  if (!raw) {
    return fallback;
  }

  return raw.trim().toLowerCase() === "true";
}

/**
 * Cargo flags are the same for every harness; only the args after `--` differ.
 */
function buildBenchCmd(inputs) {
  let benchCmd = ["bench"];

  if (inputs.package) {
    benchCmd = benchCmd.concat(["--package", inputs.package]);
  }

  if (inputs.benchName) {
    benchCmd = benchCmd.concat(["--bench", inputs.benchName]);
  }

  if (!inputs.defaultFeatures) {
    benchCmd = benchCmd.concat(["--no-default-features"]);
  }

  if (inputs.features) {
    benchCmd = benchCmd.concat(["--features", inputs.features]);
  }

  return benchCmd;
}

function captureOptions(options) {
  const captured = { stdout: "", stderr: "" };

  return {
    captured,
    options: {
      ...options,
      listeners: {
        stdout: (data) => {
          captured.stdout += data.toString();
        },
        stderr: (data) => {
          captured.stderr += data.toString();
        },
      },
    },
  };
}

async function main() {
  const inputs = {
    token: core.getInput("token", { required: true }),
    branchName: core.getInput("branchName", { required: true }),
    cwd: core.getInput("cwd"),
    benchName: core.getInput("benchName"),
    package: core.getInput("package"),
    features: core.getInput("features"),
    defaultFeatures: getBooleanInput("defaultFeatures", true),
    harness: (core.getInput("harness") || "criterion").trim().toLowerCase(),
    before: core.getInput("before"),
  };
  core.debug(`Inputs: ${inspect(inputs)}`);

  const runner = getRunner(inputs.harness);
  core.debug(`Using the '${runner.name}' harness`);

  const options = {};
  if (inputs.cwd) {
    options.cwd = inputs.cwd;
  }

  const benchCmd = buildBenchCmd(inputs);

  const baseBranch =
    inputs.branchName ||
    (context.payload.pull_request && context.payload.pull_request.base.ref);

  if (!baseBranch) {
    throw new Error(
      "Could not determine the base branch. Set the `branchName` input."
    );
  }

  if (runner.prepare) {
    await runner.prepare(options);
  }

  // Where to return to after benchmarking the base branch. `context.sha` is the
  // merge commit on `pull_request` events, so prefer the PR head sha, which is
  // guaranteed to exist in the checkout.
  const headRef =
    (context.payload.pull_request && context.payload.pull_request.head.sha) ||
    context.sha;

  // Each run's stdout is captured; whichever run produces the comparison is
  // the one we parse.
  let comparisonOutput = { stdout: "", stderr: "" };

  // Runs on whichever branch is currently checked out, so the `before` command
  // gets a chance to prepare each tree before its benchmarks are measured.
  async function benchmark(extraArgs) {
    if (inputs.before) {
      await exec.exec(inputs.before, [], options);
    }

    const { captured, options: execOptions } = captureOptions(options);
    await exec.exec("cargo", benchCmd.concat(["--"], extraArgs), execOptions);
    return captured;
  }

  if (runner.order === "base-first") {
    // gungraun compares against the saved baseline during the second run, so
    // the base branch has to be measured first.
    await exec.exec("git", ["fetch"]);
    await exec.exec("git", ["checkout", baseBranch]);
    core.debug("Checked out to base branch");

    await benchmark(runner.benchArgsForBase());
    core.debug("Base benchmarked");

    await exec.exec("git", ["checkout", headRef]);
    core.debug("Checked out back to PR head");

    comparisonOutput = await benchmark(runner.benchArgsForChanges());
    core.debug("Changes benchmarked");
  } else {
    await benchmark(runner.benchArgsForChanges());
    core.debug("Changes benchmarked");

    await exec.exec("git", ["fetch"]);
    await exec.exec("git", ["checkout", baseBranch]);
    core.debug("Checked out to base branch");

    comparisonOutput = await benchmark(runner.benchArgsForBase());
    core.debug("Base benchmarked");
  }

  if (!runner.comparisonFromSecondRun) {
    comparisonOutput = await runner.compare(options);
  }

  core.setOutput("stdout", comparisonOutput.stdout);
  core.setOutput("stderr", comparisonOutput.stderr);

  const rows = runner.parse(comparisonOutput.stdout);
  const resultsAsMarkdown = renderMarkdown(rows, context.sha);

  // An authenticated instance of `@octokit/rest`
  const octokit = github.getOctokit(inputs.token);

  const contextObj = { ...context.issue };

  try {
    const { data: comment } = await octokit.rest.issues.createComment({
      owner: contextObj.owner,
      repo: contextObj.repo,
      issue_number: contextObj.number,
      body: resultsAsMarkdown,
    });
    core.info(
      `Created comment id '${comment.id}' on issue '${contextObj.number}' in '${contextObj.repo}'.`
    );
    core.setOutput("comment-id", comment.id);
  } catch (err) {
    core.warning(`Failed to comment: ${err}`);
    core.info("Commenting is not possible from forks.");

    // If we can't post to the comment, display results here.
    // forkedRepos only have READ ONLY access on GITHUB_TOKEN
    // https://github.community/t5/GitHub-Actions/quot-Resource-not-accessible-by-integration-quot-for-adding-a/td-p/33925
    console.table(renderTable(rows));
  }

  core.debug("Succesfully run!");
}

try {
  await main();
} catch (e) {
  console.log(e.stack);
  core.setFailed(`Unhanded error:\n${e}`);
}
