/**
 * One PR comment holds the results of every run for the same commit. Each run
 * owns one section of that comment, so a matrix of benchmarks gives one
 * comment and not one comment for each benchmark.
 *
 * The comment body has this layout:
 *
 *   <!-- rust-bench-compare:sha <sha> -->
 *   <!-- rust-bench-compare:section <key> -->
 *   <markdown of one run>
 *   <!-- rust-bench-compare:end <key> -->
 *   ...more sections, sorted by key...
 *
 * The GitHub API has no locks. Thus parallel jobs can overwrite the sections
 * of other jobs. After each write, a run waits, reads the comment again and
 * tries again if its section is not there.
 */

const MARKER_PREFIX = "<!-- rust-bench-compare:";
const SECTION_PATTERN =
  /<!-- rust-bench-compare:section (\S+) -->\n([\s\S]*?)\n<!-- rust-bench-compare:end \1 -->/g;

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_SETTLE_MS = 3000;

function shaMarker(sha) {
  return `${MARKER_PREFIX}sha ${sha} -->`;
}

/**
 * GitHub can return a body with CRLF line endings or with the trailing
 * whitespace removed. Compare and store only the normalized form.
 */
function normalize(text) {
  return text.replace(/\r\n/g, "\n").trim();
}

/**
 * Two runs get the same key only if they benchmark the same thing. Each part
 * is URI-encoded, so the key has no whitespace and cannot close the HTML
 * comment that holds it.
 */
function sectionKey({
  harness,
  cwd,
  package: pkg,
  benchName,
  features,
  defaultFeatures,
}) {
  const featureMode = defaultFeatures ? "default" : "no-default";

  return [harness, cwd, pkg, benchName, features, featureMode]
    .map((part) => encodeURIComponent(part || ""))
    .join("/");
}

function isSharedComment(body, sha) {
  return normalize(body || "").startsWith(shaMarker(sha));
}

/**
 * @returns {Map<string, string>} The sections of a shared comment, by key.
 */
function parseSections(body) {
  const sections = new Map();

  for (const [, key, content] of normalize(body || "").matchAll(
    SECTION_PATTERN
  )) {
    sections.set(key, normalize(content));
  }

  return sections;
}

/**
 * Each marker has blank lines around it. Without them, Markdown continues an
 * HTML block such as `</details>` into the next section and shows that
 * section as raw text.
 */
function renderComment(sha, sections) {
  const rendered = [...sections.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, content]) =>
        `${MARKER_PREFIX}section ${key} -->\n\n${normalize(
          content
        )}\n\n${MARKER_PREFIX}end ${key} -->`
    );

  return [shaMarker(sha), ...rendered].join("\n\n") + "\n";
}

/**
 * @returns {string} `body` with the section for `key` set to `content`. The
 *   other sections do not change.
 */
function mergeSection(body, sha, key, content) {
  const sections = parseSections(body);
  sections.set(key, normalize(content));
  return renderComment(sha, sections);
}

/**
 * @returns The shared comments for `sha`, oldest first. The oldest is the
 *   primary comment; the others are duplicates from runs that started at the
 *   same time.
 */
async function findSharedComments(api, sha) {
  const comments = await api.listComments();

  return comments
    .filter((comment) => isSharedComment(comment.body, sha))
    .sort((a, b) => a.id - b.id);
}

async function deleteDuplicate(api, comment) {
  try {
    await api.deleteComment(comment.id);
  } catch (err) {
    // A different run can delete the same duplicate first.
    if (err.status !== 404) {
      throw err;
    }
  }
}

/**
 * Write one section and fold the duplicates into the primary comment.
 *
 * @returns The comment that holds the section.
 */
async function writeSection(api, sha, key, content) {
  const [primary, ...duplicates] = await findSharedComments(api, sha);

  if (!primary) {
    return api.createComment(renderComment(sha, new Map([[key, content]])));
  }

  // The primary comment has priority over duplicates, and this run has
  // priority over both.
  const sections = new Map();
  for (const comment of [...duplicates].reverse().concat(primary)) {
    for (const [otherKey, otherContent] of parseSections(comment.body)) {
      sections.set(otherKey, otherContent);
    }
  }
  sections.set(key, content);

  const updated = await api.updateComment(
    primary.id,
    renderComment(sha, sections)
  );

  for (const duplicate of duplicates) {
    await deleteDuplicate(api, duplicate);
  }

  return updated;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Put `content` in the section for `key` of the shared comment for `sha`.
 * Make the comment if it does not exist.
 *
 * @param {object} args
 * @param {object} args.api Has `listComments()`, `createComment(body)`,
 *   `updateComment(id, body)` and `deleteComment(id)`.
 * @returns The shared comment after the section is verified.
 * @throws If the section is not in the comment after `maxAttempts` writes.
 */
async function upsertSection({
  api,
  sha,
  key,
  content,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  settleMs = DEFAULT_SETTLE_MS,
  sleep = defaultSleep,
  random = Math.random,
  log = () => {},
}) {
  const expected = normalize(content);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await writeSection(api, sha, key, expected);

    // Random wait, so that parallel runs do not write at the same time again.
    await sleep(settleMs * (1 + random()));

    const [primary] = await findSharedComments(api, sha);
    if (primary && parseSections(primary.body).get(key) === expected) {
      return primary;
    }

    log(
      `A different run changed the comment at the same time (attempt ${attempt} of ${maxAttempts}). Trying again.`
    );
  }

  throw new Error(
    `The benchmark section is not in the comment after ${maxAttempts} attempts.`
  );
}

export {
  sectionKey,
  isSharedComment,
  parseSections,
  renderComment,
  mergeSection,
  upsertSection,
};
