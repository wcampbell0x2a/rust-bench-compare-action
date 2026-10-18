import test from "node:test";
import assert from "node:assert";

import {
  sectionKey,
  isSharedComment,
  parseSections,
  renderComment,
  mergeSection,
  upsertSection,
} from "../lib/comment.js";

const SHA = "abc1234def5678";

const baseInputs = {
  harness: "gungraun",
  cwd: "",
  package: "",
  benchName: "deku_callgrind",
  features: "alloc,bits",
  defaultFeatures: true,
};

/** Deterministic PRNG (mulberry32), so that a failing seed can be replayed. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * In-memory issue comments. Each call yields to the event loop a random
 * number of times, so that parallel callers interleave like real API calls.
 */
function fakeApi(random = () => 0) {
  const comments = new Map();
  let nextId = 1;
  const calls = { create: 0, update: 0, delete: 0 };

  async function yieldRandomly() {
    const turns = Math.floor(random() * 4);
    for (let i = 0; i < turns; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  function notFound() {
    const err = new Error("Not Found");
    err.status = 404;
    return err;
  }

  return {
    comments,
    calls,
    async listComments() {
      await yieldRandomly();
      return [...comments.values()].map((c) => ({ ...c }));
    },
    async createComment(body) {
      await yieldRandomly();
      calls.create++;
      const comment = { id: nextId++, body };
      comments.set(comment.id, comment);
      return { ...comment };
    },
    async updateComment(id, body) {
      await yieldRandomly();
      calls.update++;
      if (!comments.has(id)) {
        throw notFound();
      }
      comments.set(id, { id, body });
      return { id, body };
    },
    async deleteComment(id) {
      await yieldRandomly();
      calls.delete++;
      if (!comments.delete(id)) {
        throw notFound();
      }
    },
  };
}

const noSleep = () => Promise.resolve();

test("comment: the section key is stable and changes with each input", () => {
  assert.equal(sectionKey(baseInputs), sectionKey({ ...baseInputs }));

  const variants = [
    { harness: "criterion" },
    { cwd: "sub" },
    { package: "deku" },
    { benchName: "bebits_callgrind" },
    { features: "alloc" },
    { defaultFeatures: false },
  ];
  const keys = new Set(
    variants.map((v) => sectionKey({ ...baseInputs, ...v }))
  );
  keys.add(sectionKey(baseInputs));

  assert.equal(keys.size, variants.length + 1);
});

test("comment: the section key cannot break the HTML comment", () => {
  const key = sectionKey({
    ...baseInputs,
    benchName: "bad --> name with spaces",
  });

  assert.ok(!/\s/.test(key));
  assert.ok(!key.includes("-->"));

  const body = renderComment(SHA, new Map([[key, "content"]]));
  assert.equal(parseSections(body).get(key), "content");
});

test("comment: the section key accepts missing inputs", () => {
  assert.equal(sectionKey({}), "/////no-default");
});

test("comment: render and parse are inverse operations", () => {
  const sections = new Map([
    ["b", "## Second\n| a | b |"],
    ["a", "## First"],
  ]);
  const body = renderComment(SHA, sections);

  assert.ok(isSharedComment(body, SHA));
  assert.deepEqual(parseSections(body), sections);
  assert.ok(body.indexOf("## First") < body.indexOf("## Second"));
});

test("comment: parse accepts CRLF and trailing whitespace from GitHub", () => {
  const body = renderComment(SHA, new Map([["k", "line 1\nline 2"]]))
    .replace(/\n/g, "\r\n")
    .concat("   ");

  assert.ok(isSharedComment(body, SHA));
  assert.equal(parseSections(body).get("k"), "line 1\nline 2");
});

test("comment: a comment for a different commit or without a marker is not shared", () => {
  const body = renderComment(SHA, new Map([["k", "x"]]));

  assert.equal(isSharedComment(body, "0000000"), false);
  assert.equal(isSharedComment("## Benchmark for abc1234", SHA), false);
  assert.equal(isSharedComment(undefined, SHA), false);
  assert.equal(parseSections("no sections here").size, 0);
});

test("comment: merge replaces only its own section", () => {
  let body = renderComment(SHA, new Map());
  body = mergeSection(body, SHA, "a", "first");
  body = mergeSection(body, SHA, "b", "second");
  body = mergeSection(body, SHA, "a", "first again");

  assert.deepEqual(
    parseSections(body),
    new Map([
      ["a", "first again"],
      ["b", "second"],
    ])
  );
});

test("comment: merge gives the same body in any order (randomized)", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const random = seededRandom(seed);
    const entries = Array.from(
      { length: 1 + Math.floor(random() * 6) },
      (_, i) => [`key${i}`, `content ${i} ${random()}`]
    );
    const shuffled = [...entries].sort(() => random() - 0.5);

    const merge = (list) =>
      list.reduce(
        (body, [key, content]) => mergeSection(body, SHA, key, content),
        ""
      );

    assert.equal(merge(shuffled), merge(entries), `seed ${seed}`);
    assert.deepEqual(
      parseSections(merge(entries)),
      new Map(entries),
      `seed ${seed}`
    );
  }
});

test("comment: upsert makes the comment if it does not exist", async () => {
  const api = fakeApi();

  const comment = await upsertSection({
    api,
    sha: SHA,
    key: "k",
    content: "results",
    sleep: noSleep,
  });

  assert.equal(api.comments.size, 1);
  assert.equal(parseSections(comment.body).get("k"), "results");
});

test("comment: upsert adds to the comment for the same commit", async () => {
  const api = fakeApi();
  const args = { api, sha: SHA, sleep: noSleep };

  await upsertSection({ ...args, key: "a", content: "first" });
  await upsertSection({ ...args, key: "b", content: "second" });
  const comment = await upsertSection({ ...args, key: "a", content: "rerun" });

  assert.equal(api.comments.size, 1);
  assert.deepEqual(
    parseSections(comment.body),
    new Map([
      ["a", "rerun"],
      ["b", "second"],
    ])
  );
});

test("comment: upsert makes a new comment for a new commit", async () => {
  const api = fakeApi();

  await upsertSection({
    api,
    sha: SHA,
    key: "a",
    content: "old",
    sleep: noSleep,
  });
  await upsertSection({
    api,
    sha: "fff9999",
    key: "a",
    content: "new",
    sleep: noSleep,
  });

  assert.equal(api.comments.size, 2);
});

test("comment: upsert does not change comments without the marker", async () => {
  const api = fakeApi();
  await api.createComment("A human comment");

  await upsertSection({
    api,
    sha: SHA,
    key: "a",
    content: "x",
    sleep: noSleep,
  });

  assert.equal(api.comments.get(1).body, "A human comment");
  assert.equal(api.comments.size, 2);
});

test("comment: upsert folds duplicate comments into the oldest one", async () => {
  const api = fakeApi();
  await api.createComment(renderComment(SHA, new Map([["a", "from a"]])));
  await api.createComment(renderComment(SHA, new Map([["b", "from b"]])));

  const comment = await upsertSection({
    api,
    sha: SHA,
    key: "c",
    content: "from c",
    sleep: noSleep,
  });

  assert.equal(comment.id, 1);
  assert.deepEqual([...api.comments.keys()], [1]);
  assert.deepEqual(
    parseSections(comment.body),
    new Map([
      ["a", "from a"],
      ["b", "from b"],
      ["c", "from c"],
    ])
  );
});

test("comment: upsert tries again when a different run overwrites it", async () => {
  const api = fakeApi();
  const retries = [];

  // On the first wait, a different run writes a body that does not have this
  // section, like a run that read the comment before this run wrote it.
  let waits = 0;
  const sleep = async () => {
    if (waits++ === 0) {
      const [comment] = api.comments.values();
      api.comments.set(comment.id, {
        id: comment.id,
        body: renderComment(SHA, new Map([["other", "x"]])),
      });
    }
  };

  const comment = await upsertSection({
    api,
    sha: SHA,
    key: "mine",
    content: "y",
    sleep,
    log: (message) => retries.push(message),
  });

  assert.equal(retries.length, 1);
  assert.deepEqual(
    parseSections(comment.body),
    new Map([
      ["mine", "y"],
      ["other", "x"],
    ])
  );
});

test("comment: upsert fails after the maximum number of attempts", async () => {
  const api = fakeApi();
  const sleep = async () => {
    for (const id of api.comments.keys()) {
      api.comments.set(id, { id, body: renderComment(SHA, new Map()) });
    }
  };

  await assert.rejects(
    upsertSection({
      api,
      sha: SHA,
      key: "k",
      content: "x",
      sleep,
      maxAttempts: 3,
    }),
    /not in the comment after 3 attempts/
  );
  assert.equal(api.calls.create + api.calls.update, 3);
});

test("comment: the wait before verify uses jitter", async () => {
  const waits = [];
  const values = [0, 0.5];

  await upsertSection({
    api: fakeApi(),
    sha: SHA,
    key: "k",
    content: "x",
    settleMs: 1000,
    sleep: async (ms) => waits.push(ms),
    random: () => values.shift(),
  });

  assert.deepEqual(waits, [1000]);
});

test("comment: parallel runs give one comment with all sections (randomized)", async () => {
  for (let seed = 1; seed <= 100; seed++) {
    const random = seededRandom(seed);
    const api = fakeApi(random);
    const keys = ["deku", "bebits", "protocol_pipeline"];

    // The wait yields so that the other runs can write in between.
    const sleep = async () => {
      const turns = 1 + Math.floor(random() * 8);
      for (let i = 0; i < turns; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };

    await Promise.all(
      keys.map((key) =>
        upsertSection({
          api,
          sha: SHA,
          key,
          content: `results for ${key}`,
          sleep,
          random,
          maxAttempts: 20,
        })
      )
    );

    const shared = [...api.comments.values()];
    assert.equal(shared.length, 1, `seed ${seed}`);
    assert.deepEqual(
      [...parseSections(shared[0].body).keys()].sort(),
      [...keys].sort(),
      `seed ${seed}`
    );
  }
});

test("comment: a blank line separates each marker from the Markdown", () => {
  const body = renderComment(
    SHA,
    new Map([
      ["a", "## First\n  <details>\n  </details>"],
      ["b", "## Second"],
    ])
  );
  const lines = body.split("\n");

  lines.forEach((line, i) => {
    if (line.startsWith("<!-- rust-bench-compare:")) {
      assert.ok(i === 0 || lines[i - 1] === "", `blank line before ${line}`);
      assert.equal(lines[i + 1], "", `blank line after ${line}`);
    }
  });
});

test("comment: parse reads a body from the earlier layout without blank lines", () => {
  const body = [
    `<!-- rust-bench-compare:sha ${SHA} -->`,
    "<!-- rust-bench-compare:section a -->",
    "## First",
    "<!-- rust-bench-compare:end a -->",
  ].join("\n");

  assert.equal(parseSections(body).get("a"), "## First");
});
