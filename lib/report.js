/**
 * Shared reporting helpers used by every harness runner.
 *
 * A runner's `parse` returns rows of the shape:
 *
 *   { name, base, changes, difference, significant }
 *
 * where `base`/`changes` are already-formatted display strings (or `"N/A"`),
 * `difference` is a formatted percentage string (or `"N/A"`), and `significant`
 * marks the row for bolding.
 */

/**
 * Non-overlapping error bar check. Only meaningful for harnesses that report a
 * spread; count-based harnesses decide significance differently.
 */
function isSignificant(changesDur, changesErr, baseDur, baseErr) {
  if (changesDur < baseDur) {
    return changesDur + changesErr < baseDur || baseDur - baseErr > changesDur;
  } else {
    return changesDur - changesErr > baseDur || baseDur + baseErr < changesDur;
  }
}

function escapeName(name) {
  return name.replace(/\|/g, "\\|");
}

function formatRow({ name, base, changes, difference, significant, faster }) {
  if (significant) {
    difference = `**${difference}**`;
    if (faster) {
      changes = `**${changes}**`;
    } else {
      base = `**${base}**`;
    }
  }

  return `| ${escapeName(name)} | ${base} | ${changes} | ${difference} |`;
}

function renderMarkdown(rows, sha, harness) {
  const shortSha = sha.slice(0, 7);
  const body = rows.map(formatRow).join("\n");
  const title = harness ? `${harness} Benchmark` : "Benchmark";

  return `## ${title} for ${shortSha}
  <details>
    <summary>Click to view benchmark</summary>

| Test | Base         | PR               | % |
|------|--------------|------------------|---|
${body}

  </details>
  `;
}

/**
 * Fork fallback: commenting requires write access, which forked PRs don't get.
 */
function renderTable(rows) {
  return rows.map(({ name, base, changes, difference }) => ({
    name,
    baseDuration: base,
    changesDuration: changes,
    difference,
  }));
}

export { isSignificant, escapeName, renderMarkdown, renderTable };
