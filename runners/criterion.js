import * as exec from "@actions/exec";
import * as core from "@actions/core";

import { isSignificant } from "../lib/report.js";

function convertDurToSeconds(dur, units) {
  let seconds;
  switch (units) {
    case "s":
      seconds = dur;
      break;
    case "ms":
      seconds = dur / 1000;
      break;
    case "µs":
      seconds = dur / 1000000;
      break;
    case "ns":
      seconds = dur / 1000000000;
      break;
    default:
      seconds = dur;
      break;
  }

  return seconds;
}

/**
 * Parses critcmp's plaintext table, e.g.
 *
 *   group                            base                                   changes
 *   -----                            ----                                   -------
 *   character module                 1.03     22.2±0.41ms        ? B/sec    1.00     21.6±0.53ms        ? B/sec
 */
function parse(results) {
  return results
    .trimRight()
    .split("\n")
    .slice(2) // skip headers
    .map((row) => row.split(/\s{2,}/)) // split if 2+ spaces together
    .map(
      ([
        name,
        baseFactor,
        baseDuration,
        _baseBandwidth,
        changesFactor,
        changesDuration,
        _changesBandwidth,
      ]) => {
        const baseUndefined = typeof baseDuration === "undefined";
        const changesUndefined = typeof changesDuration === "undefined";

        if (!name || (baseUndefined && changesUndefined)) {
          return null;
        }

        let difference = "N/A";
        let significant = false;
        let faster = false;

        if (!baseUndefined && !changesUndefined) {
          const changesDurSplit = changesDuration.split("±");
          const changesUnits = changesDurSplit[1].slice(-2);
          const changesDurSecs = convertDurToSeconds(
            changesDurSplit[0],
            changesUnits
          );
          const changesErrorSecs = convertDurToSeconds(
            changesDurSplit[1].slice(0, -2),
            changesUnits
          );

          const baseDurSplit = baseDuration.split("±");
          const baseUnits = baseDurSplit[1].slice(-2);
          const baseDurSecs = convertDurToSeconds(baseDurSplit[0], baseUnits);
          const baseErrorSecs = convertDurToSeconds(
            baseDurSplit[1].slice(0, -2),
            baseUnits
          );

          difference = -(1 - changesDurSecs / baseDurSecs) * 100;
          difference =
            (changesDurSecs <= baseDurSecs ? "" : "+") +
            difference.toFixed(2) +
            "%";

          if (
            isSignificant(
              changesDurSecs,
              changesErrorSecs,
              baseDurSecs,
              baseErrorSecs
            )
          ) {
            // A tie is not bolded on either side, matching the original.
            if (changesDurSecs < baseDurSecs) {
              significant = true;
              faster = true;
            } else if (changesDurSecs > baseDurSecs) {
              significant = true;
              faster = false;
            }
          }
        }

        return {
          name,
          base: baseUndefined ? "N/A" : baseDuration,
          changes: changesUndefined ? "N/A" : changesDuration,
          difference,
          significant,
          faster,
        };
      }
    )
    .filter((row) => row !== null);
}

export default {
  name: "criterion",
  displayName: "Criterion",

  // criterion benches the PR first, then the base branch, then diffs the two
  // saved baselines with critcmp.
  order: "changes-first",

  async prepare() {
    core.debug("### Install Critcmp ###");
    await exec.exec("cargo", ["install", "critcmp"]);
  },

  benchArgsForChanges() {
    return ["--save-baseline", "changes"];
  },

  benchArgsForBase() {
    return ["--save-baseline", "base"];
  },

  // The comparison needs a separate critcmp invocation.
  comparisonFromSecondRun: false,

  async compare(options) {
    let stdout = "";
    let stderr = "";

    await exec.exec("critcmp", ["base", "changes"], {
      ...options,
      listeners: {
        stdout: (data) => {
          stdout += data.toString();
        },
        stderr: (data) => {
          stderr += data.toString();
        },
      },
    });

    return { stdout, stderr };
  },

  parse,

  // exported for tests
  convertDurToSeconds,
};
