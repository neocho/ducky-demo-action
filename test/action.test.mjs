// The one-intake contract, pinned. Every case runs the real index.mjs as a
// subprocess against a scripted Ducky/GitHub API (fetch-stub), so exit codes,
// ordering, and request bodies are asserted end to end.
//
// The invariant under all of it: one run makes ONE render submission at most,
// the server declares who posts the comment, and no answer of any shape talks
// this action into a second render.

import assert from "node:assert/strict";
import { test } from "node:test";
import { API, SHA, bodyOf, hits, runAction, SHA as FULL_SHA } from "./helpers.mjs";

const TRIGGER = "/v1/github/trigger/octo-org/widget-app";
const COMPOSED_BODY = "### 🦆 Ducky demo\n\ncomposed by the server";

// An explicitly open PR, so every case below also pins that a stated "open"
// runs normally; the bespoke events elsewhere state no status at all, which
// must run normally too.
const prEvent = { pull_request: { number: 12, state: "open", head: { sha: SHA, repo: { full_name: "octo-org/widget-app" } } } };
// A push run carries no PR in context (action.yml maps nothing there), so it
// resolves one from the commit.
const pushEnv = { GITHUB_EVENT_NAME: "push", PR_NUMBER: "" };

/** The PR read and the diff read every run makes before the one intake call.
 *  Two rules on the same URL, consumed in order: the JSON read, then the diff. */
const prContent = (n = 12) => [
  { url: `/pulls/${n}`, times: 1, json: { title: "Add widget", body: "adds a widget" } },
  { url: `/pulls/${n}`, times: 1, text: "diff --git a/widget.js b/widget.js" },
];
/** A push run's commit → open-PR lookup, plus that PR's content. */
const openPr = (n = 7) => [{ url: "/commits/", json: [{ number: n, state: "open" }] }, ...prContent(n)];

/** An accepted render, with the owner the server declares. */
const enqueued = (mode, id = "rnd_1", extra = {}) => ({
  url: TRIGGER,
  method: "POST",
  status: 202,
  json: { status: "enqueued", render_id: id, mode, ...extra },
});

/** The invariant, asserted per case: `expected` submissions to the Ducky API
 *  (the only POST it receives is the intake call), and never the from-pr route. */
function assertIntakes(requests, expected) {
  const submissions = requests.filter((r) => r.method === "POST" && r.url.startsWith(API));
  assert.equal(submissions.length, expected, `submissions were: ${submissions.map((s) => s.url).join(" , ") || "none"}`);
  assert.equal(hits(requests, "/from-pr").length, 0, "the from-pr route no longer exists");
}

// ─── mode "app": the Ducky GitHub App owns the comment ──────────────────────

test('mode "app": polls to done, posts nothing, submits exactly one render', () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [
      ...prContent(),
      enqueued("app", "rnd_1", { pr_number: 12 }),
      { url: "/v1/renders/rnd_1", times: 2, json: { status: "running" } },
      { url: "/v1/renders/rnd_1", json: { status: "done", demo_url: "https://cdn.example.test/demo.mp4" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /the Ducky GitHub App owns render rnd_1 \(PR #12\)/);
  assert.match(out, /finished \(done\)/, "must reach the terminal poll, not the expiry branch");
  assert.equal(hits(requests, "/issues/").length, 0, "the App posts the comment; this run must not");
  assertIntakes(requests, 1);
  const trigger = bodyOf(requests, TRIGGER);
  assert.equal(trigger.sha, SHA);
  assert.equal(trigger.url, "https://preview.example.test");
  assert.equal(trigger.dedup, true);
  assert.equal(trigger.reel, true);
  assert.equal(trigger.title, "Add widget", "the content rides even when the App will ignore it");
});

test('mode "app": a failed render turns the check red', () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [
      ...prContent(),
      enqueued("app"),
      { url: "/v1/renders/rnd_1", json: { status: "failed" } },
    ],
  });
  assert.equal(code, 1, out);
  assert.match(out, /render failed/);
  assert.equal(hits(requests, "/issues/").length, 0);
  assertIntakes(requests, 1);
});

test('mode "app": a terminal skip is green', () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [
      ...prContent(),
      enqueued("app"),
      { url: "/v1/renders/rnd_1", json: { status: "skipped" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /finished \(skipped\)/);
  assert.equal(hits(requests, "/issues/").length, 0);
});

test('mode "app": poll budget expiry exits 0 with no comment (the App still posts)', () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    env: { RENDER_TIMEOUT: "1" },
    spec: [
      ...prContent(),
      enqueued("app"),
      { url: "/v1/renders/rnd_1", json: { status: "running" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /poll budget expired/);
  assert.equal(hits(requests, "/issues/").length, 0);
  assertIntakes(requests, 1);
});

test('mode "app": every poll failing goes red, never a silent green', () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    env: { RENDER_TIMEOUT: "1" },
    spec: [
      ...prContent(),
      enqueued("app"),
      { url: "/v1/renders/rnd_1", status: 500, json: { error: { code: "internal", message: "Internal server error" } } },
    ],
  });
  assert.equal(code, 1, out);
  assert.match(out, /could not read its status even once/);
  assertIntakes(requests, 1);
});

// ─── mode "action": this run owns the comment ───────────────────────────────

test('mode "action": polls, fetches the composed comment, and posts it exactly once', () => {
  const { code, out, requests } = runAction({
    env: pushEnv,
    spec: [
      ...openPr(7),
      enqueued("action", "rnd_a"),
      { url: "/v1/renders/rnd_a/comment", json: { outcome: "ready", post: true, body: COMPOSED_BODY } },
      { url: "/v1/renders/rnd_a", json: { status: "done", demo_url: "https://cdn.example.test/demo.mp4" } },
      { url: "/issues/7/comments", method: "POST", status: 201, json: {} },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(hits(requests, "/issues/7/comments").length, 1, "exactly one comment");
  assert.equal(bodyOf(requests, "/issues/7/comments").body, COMPOSED_BODY, "the served body posts verbatim");
  assertIntakes(requests, 1);
  // strict order: intake, poll to terminal, comment fetch, post
  const urls = requests.map((r) => r.url);
  const iIntake = urls.findIndex((u) => u.includes(TRIGGER));
  const iPoll = urls.findIndex((u) => u.includes("/rnd_a") && !u.includes("/comment"));
  const iComment = urls.findIndex((u) => u.includes("/rnd_a/comment"));
  const iPost = urls.findIndex((u) => u.includes("/issues/7/comments"));
  assert.ok(iIntake < iPoll && iPoll < iComment && iComment < iPost, `order was ${urls.join(" -> ")}`);
  // the content the server derives from rides the one call
  const body = bodyOf(requests, TRIGGER);
  assert.equal(body.title, "Add widget");
  assert.equal(body.body, "adds a widget");
  assert.match(body.diff, /^diff --git/);
});

test('mode "action": a held render posts the served held note verbatim and stays green', () => {
  const heldBody = "### 🦆 Ducky demo held\n\nheld note";
  const { code, requests, out } = runAction({
    env: pushEnv,
    spec: [
      ...openPr(7),
      enqueued("action", "rnd_h"),
      { url: "/v1/renders/rnd_h/comment", json: { outcome: "held", post: true, body: heldBody } },
      { url: "/v1/renders/rnd_h", json: { status: "done" } },
      { url: "/issues/7/comments", method: "POST", status: 201, json: {} },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(bodyOf(requests, "/issues/7/comments").body, heldBody);
});

test('mode "action": a failed render posts the served failure note and the check goes red', () => {
  const failBody = "### 🦆 Couldn't render the demo";
  const { code, requests, out } = runAction({
    env: pushEnv,
    spec: [
      ...openPr(7),
      enqueued("action", "rnd_f"),
      { url: "/v1/renders/rnd_f/comment", json: { outcome: "failed", post: true, body: failBody } },
      { url: "/v1/renders/rnd_f", json: { status: "failed" } },
      { url: "/issues/7/comments", method: "POST", status: 201, json: {} },
    ],
  });
  assert.equal(code, 1, out);
  assert.equal(bodyOf(requests, "/issues/7/comments").body, failBody, "the failure note posts before the red exit");
  assertIntakes(requests, 1);
});

test('mode "action": a comment the server says not to post stays unposted and green', () => {
  const { code, out, requests } = runAction({
    env: pushEnv,
    spec: [
      ...openPr(7),
      enqueued("action", "rnd_q"),
      { url: "/v1/renders/rnd_q/comment", json: { outcome: "skipped", post: false } },
      { url: "/v1/renders/rnd_q", json: { status: "skipped" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /nothing to post/);
  assert.equal(hits(requests, "/issues/").length, 0);
});

test('mode "action": an unreachable comment endpoint exits by render status with no invented body', () => {
  const { code, requests, out } = runAction({
    env: pushEnv,
    spec: [
      ...openPr(7),
      enqueued("action", "rnd_d"),
      { url: "/v1/renders/rnd_d/comment", status: 500, json: {} },
      { url: "/v1/renders/rnd_d", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /could not fetch the composed comment/);
  assert.equal(hits(requests, "/issues/").length, 0);
});

test('mode "action": render-timeout expiry posts the past-tense note and exits 0', () => {
  const { code, out, requests } = runAction({
    env: { ...pushEnv, RENDER_TIMEOUT: "0" },
    spec: [
      ...openPr(7),
      enqueued("action", "rnd_slow"),
      { url: "/v1/renders/rnd_slow", json: { status: "running" } },
      { url: "/issues/7/comments", method: "POST", status: 201, json: {} },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(bodyOf(requests, "/issues/7/comments").body, /still rendering when this check finished/);
  assert.match(out, /render-timeout/);
  assert.equal(hits(requests, "/rnd_slow/comment").length, 0, "no comment fetch on the timeout path");
});

test('mode "action": a failed note POST logs honestly and still exits 0', () => {
  const { code, out } = runAction({
    env: { ...pushEnv, RENDER_TIMEOUT: "0" },
    spec: [
      ...openPr(7),
      enqueued("action", "rnd_slow"),
      { url: "/v1/renders/rnd_slow", json: { status: "running" } },
      { url: "/issues/7/comments", method: "POST", status: 403, json: { message: "Resource not accessible by integration" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /could not post the note/);
});

test('mode "action": every poll failing goes red with no false note', () => {
  const { code, out, requests } = runAction({
    env: { ...pushEnv, RENDER_TIMEOUT: "1" },
    spec: [
      ...openPr(7),
      enqueued("action", "rnd_x"),
      { url: "/v1/renders/rnd_x", status: 500, json: { error: { code: "internal", message: "Internal server error" } } },
    ],
  });
  assert.equal(code, 1, out);
  assert.match(out, /could not be read even once/);
  assert.equal(hits(requests, "/issues/").length, 0, "no note may be posted about a render never observed");
  assertIntakes(requests, 1);
});

// ─── 200: every skip is terminal ────────────────────────────────────────────

test("a 200 skip for no open PR is terminal: no poll, no comment, no second render", () => {
  const { code, out, requests } = runAction({
    env: pushEnv,
    spec: [
      ...openPr(7),
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: "no open PR has this commit at its head", code: "no_open_pr" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /skipped: no open PR has this commit at its head/);
  assert.equal(hits(requests, "/v1/renders").length, 0, "nothing was rendered, so nothing is polled");
  assert.equal(hits(requests, "/issues/").length, 0);
  assertIntakes(requests, 1);
});

test("a 200 skip for a not-demoable change is terminal", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [
      ...prContent(),
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: "copy-only change, nothing user-visible", code: "not_demoable", render_id: "rnd_note" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /skipped: copy-only change/);
  assert.equal(hits(requests, "/v1/renders").length, 0);
  assert.equal(hits(requests, "/issues/").length, 0);
  assertIntakes(requests, 1);
});

test("a 200 skip for a commit already rendered (dedup hit) is terminal", () => {
  const { code, requests, out } = runAction({
    event: prEvent,
    spec: [
      ...prContent(),
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: "commit already rendered", render_id: "rnd_prior" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /rnd_prior/);
  assert.equal(hits(requests, "/v1/renders").length, 0);
  assertIntakes(requests, 1);
});

test("a 200 with a non-JSON body fails loudly instead of reading as a skip", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [...prContent(), { url: TRIGGER, method: "POST", status: 200, text: "<html>gateway error</html>" }],
  });
  assert.equal(code, 1, out);
  assert.match(out, /unexpected trigger response/);
  assert.equal(hits(requests, "/v1/renders").length, 0);
  assertIntakes(requests, 1);
});

test("a 200 with an empty object fails loudly instead of exiting green", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [...prContent(), { url: TRIGGER, method: "POST", status: 200, json: {} }],
  });
  assert.equal(code, 1, out);
  assert.match(out, /unexpected trigger response/);
  assertIntakes(requests, 1);
});

// ─── malformed acceptances and failures: loud, and never a second render ────

test("a 202 without a render id fails loudly instead of polling nothing", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [...prContent(), { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", mode: "app", pr_number: 12 } }],
  });
  assert.equal(code, 1, out);
  assert.match(out, /unexpected/);
  assert.equal(hits(requests, "/v1/renders/").length, 0, "must not poll without an id");
  assertIntakes(requests, 1);
});

test("a 202 with no mode is a version mismatch, not a guess", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [...prContent(), { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1" } }],
  });
  assert.equal(code, 1, out);
  assert.match(out, /unknown mode/);
  assert.match(out, /update to the latest release/i);
  assert.equal(hits(requests, "/v1/renders/").length, 0, "an undeclared owner must not poll or post");
  assert.equal(hits(requests, "/issues/").length, 0);
  assertIntakes(requests, 1);
});

test("a 202 with a mode this release doesn't know is a version mismatch too", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [...prContent(), { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", mode: "someone-else" } }],
  });
  assert.equal(code, 1, out);
  assert.match(out, /unknown mode/);
  assert.equal(hits(requests, "/v1/renders/").length, 0);
  assertIntakes(requests, 1);
});

test("400 (caller bug): red, and nothing rendered", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [...prContent(), { url: TRIGGER, method: "POST", status: 400, json: { error: { code: "invalid_request", message: "url rejected: not public" } } }],
  });
  assert.equal(code, 1, out);
  assert.match(out, /rejected \(400\)/);
  assert.equal(hits(requests, "/v1/renders").length, 0);
  assertIntakes(requests, 1);
});

test("401 (bad key): red, naming the key", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [...prContent(), { url: TRIGGER, method: "POST", status: 401, json: { error: { code: "unauthorized", message: "Invalid API key" } } }],
  });
  assert.equal(code, 1, out);
  assert.match(out, /API key rejected \(401\)/);
  assert.equal(hits(requests, "/v1/renders").length, 0);
  assertIntakes(requests, 1);
});

test("429 (daily cap): red, naming the re-run", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [...prContent(), { url: TRIGGER, method: "POST", status: 429, json: { error: { code: "rate_limited", message: "Daily render cap reached" } } }],
  });
  assert.equal(code, 1, out);
  assert.match(out, /429/);
  assert.match(out, /Re-run this workflow/);
  assert.equal(hits(requests, "/v1/renders").length, 0, "an at-cap run must stay a red check, not a second render");
  assertIntakes(requests, 1);
});

test("5xx: red, naming the re-run, with nothing rendered behind our back", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [...prContent(), { url: TRIGGER, method: "POST", status: 500, json: { error: { code: "internal", message: "Internal server error" } } }],
  });
  assert.equal(code, 1, out);
  assert.match(out, /answered 500/);
  assert.match(out, /Re-run this workflow/);
  assert.equal(hits(requests, "/v1/renders").length, 0, "a blip must never reroute into a second render");
  assertIntakes(requests, 1);
});

test("503 on a covered repo: still red, so a stored login can never be silently dropped", () => {
  const { code, out, requests } = runAction({
    env: { ...pushEnv, RENDER_CREDENTIAL: "staging-login", RENDER_VERCEL_BYPASS: "bypass-1" },
    spec: [...openPr(7), { url: TRIGGER, method: "POST", status: 503, json: { error: { code: "unavailable", message: "upstream" } } }],
  });
  assert.equal(code, 1, out);
  assert.equal(hits(requests, "/v1/renders").length, 0);
  assertIntakes(requests, 1);
  // the one call carried the repo's config; a blip can no longer reroute the
  // render to a request that has no repo identity to look it up with
  const body = bodyOf(requests, TRIGGER);
  assert.equal(body.credential, "staging-login");
  assert.equal(body.vercel_bypass, "bypass-1");
});

test("a network error on the intake call is red, not a second attempt", () => {
  const { code, out, requests } = runAction({
    env: pushEnv,
    spec: [...openPr(7), { url: TRIGGER, method: "POST", network_error: "connect ECONNREFUSED" }],
  });
  assert.equal(code, 1, out);
  assert.match(out, /unreachable/);
  assert.match(out, /Re-run this workflow/);
  assert.equal(hits(requests, "/v1/renders").length, 0);
  assert.equal(hits(requests, "/issues/").length, 0);
  assertIntakes(requests, 1);
});

test("no answer shape talks this action into a second render submission", () => {
  // A tail generous enough to finish either mode, so nothing here is starved
  // into a false single-call result.
  const tail = [
    { url: "/v1/renders/rnd_1/comment", json: { outcome: "ready", post: true, body: COMPOSED_BODY } },
    { url: "/v1/renders/rnd_1", json: { status: "done" } },
    { url: "/issues/7/comments", method: "POST", status: 201, json: {} },
  ];
  const answers = [
    ["202 app", enqueued("app"), 0],
    ["202 action", enqueued("action"), 0],
    ["202 without a mode", { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1" } }, 1],
    ["202 unknown mode", { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", mode: "v2-owner" } }, 1],
    ["202 without a render id", { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", mode: "app" } }, 1],
    ["200 skipped", { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: "commit already rendered" } }, 0],
    ["200 malformed", { url: TRIGGER, method: "POST", status: 200, json: { status: "weird" } }, 1],
    ["400", { url: TRIGGER, method: "POST", status: 400, json: {} }, 1],
    ["401", { url: TRIGGER, method: "POST", status: 401, json: {} }, 1],
    // 403/404 used to mean "uncovered, render it yourself". Coverage is the
    // server's answer now, so these are plain failures.
    ["403", { url: TRIGGER, method: "POST", status: 403, json: {} }, 1],
    ["404", { url: TRIGGER, method: "POST", status: 404, json: {} }, 1],
    ["429", { url: TRIGGER, method: "POST", status: 429, json: {} }, 1],
    ["500", { url: TRIGGER, method: "POST", status: 500, json: {} }, 1],
    ["503", { url: TRIGGER, method: "POST", status: 503, json: {} }, 1],
    ["network error", { url: TRIGGER, method: "POST", network_error: "socket hang up" }, 1],
  ];
  for (const [name, rule, expectedCode] of answers) {
    const { code, out, requests } = runAction({ env: pushEnv, spec: [...openPr(7), rule, ...tail] });
    assert.equal(code, expectedCode, `${name} exited ${code}: ${out}`);
    const submissions = requests.filter((r) => r.method === "POST" && r.url.startsWith(API));
    assert.equal(submissions.length, 1, `${name} submitted ${submissions.length} renders`);
    assert.equal(hits(requests, "/from-pr").length, 0, `${name} reached the deleted from-pr route`);
  }
});

// ─── PR resolution: open pull requests only ─────────────────────────────────

test("push: the OPEN pull request wins over closed ones at the same commit", () => {
  const { code, out, requests } = runAction({
    env: pushEnv,
    spec: [
      { url: "/commits/", json: [{ number: 6, state: "closed" }, { number: 9, state: "open" }] },
      ...prContent(9),
      enqueued("action", "rnd_a"),
      { url: "/v1/renders/rnd_a/comment", json: { outcome: "ready", post: true, body: COMPOSED_BODY } },
      { url: "/v1/renders/rnd_a", json: { status: "done" } },
      { url: "/issues/9/comments", method: "POST", status: 201, json: {} },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /resolved PR #9/);
  assert.equal(hits(requests, "/issues/9/comments").length, 1);
});

test("push: a commit whose only PR already merged skips cleanly, rendering nothing", () => {
  const { code, out, requests } = runAction({
    env: pushEnv,
    spec: [{ url: "/commits/", json: [{ number: 7, state: "closed" }] }],
  });
  assert.equal(code, 0, out);
  assert.match(out, /no OPEN pull request/);
  assert.match(out, /Ducky demos open pull requests/);
  assert.equal(hits(requests, "/pulls/").length, 0, "no content is gathered for a PR we won't demo");
  assert.equal(hits(requests, "/issues/").length, 0);
  assertIntakes(requests, 0);
});

test("push: a direct-to-main commit with no PR at all still exits 0 quietly", () => {
  const { code, out, requests } = runAction({
    env: pushEnv,
    spec: [{ url: "/commits/", json: [] }],
  });
  assert.equal(code, 0, out);
  assert.match(out, /direct push, nothing to demo/);
  assertIntakes(requests, 0);
});

test("pull_request: a closed PR skips before reading it, waiting on a deploy, or submitting anything", () => {
  const { code, out, requests } = runAction({
    // The event names the PR, so nothing resolves it and nothing else would
    // notice it is closed. No `url` either: an early exit is the only way this
    // makes zero requests.
    event: { pull_request: { number: 12, state: "closed", head: { sha: SHA, repo: { full_name: "octo-org/widget-app" } } } },
    env: { RENDER_URL: "" },
    spec: [],
  });
  assert.equal(code, 0, out);
  assert.match(out, /pull request #12 is closed/);
  assert.match(out, /Ducky demos open pull requests/);
  assert.equal(requests.length, 0, `a closed PR must render nothing, but it requested: ${requests.map((r) => r.url).join(" , ")}`);
});

test("pull_request: the PR comes from the event context, so no commit lookup runs", () => {
  const { code, out, requests } = runAction({
    event: { pull_request: { number: 12, title: "Add widget", body: "adds a widget", head: { sha: SHA, repo: { full_name: "octo-org/widget-app" } } } },
    spec: [
      { url: "/pulls/12", text: "diff --git a/widget.js b/widget.js" },
      enqueued("app"),
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(hits(requests, "/commits/").length, 0, "the event already names the PR");
  const body = bodyOf(requests, TRIGGER);
  assert.equal(body.title, "Add widget", "the event's own title and body serve without a PR read");
  assert.equal(body.body, "adds a widget");
});

// ─── what rides the one call ────────────────────────────────────────────────

test("explicit task and credential labels ride the intake body verbatim, content included", () => {
  const { requests, code, out } = runAction({
    env: {
      ...pushEnv,
      RENDER_TASK: "Show the new checkout flow",
      RENDER_CREDENTIAL: "staging-login",
      RENDER_VERCEL_BYPASS: "bypass-1",
      RENDER_LOGIN_HINTS: "/enter, /portal",
    },
    spec: [
      ...openPr(7),
      enqueued("action", "rnd_a"),
      { url: "/v1/renders/rnd_a/comment", json: { outcome: "ready", post: true, body: COMPOSED_BODY } },
      { url: "/v1/renders/rnd_a", json: { status: "done" } },
      { url: "/issues/7/comments", method: "POST", status: 201, json: {} },
    ],
  });
  assert.equal(code, 0, out);
  const body = bodyOf(requests, TRIGGER);
  assert.equal(body.task, "Show the new checkout flow");
  assert.equal(body.credential, "staging-login");
  assert.equal(body.vercel_bypass, "bypass-1");
  assert.deepEqual(body.login_hints, ["/enter", "/portal"]);
  // an explicit task overrides the objective, never the content the comment
  // is written from
  assert.equal(body.title, "Add widget");
  assert.match(body.diff, /^diff --git/);
});

test("an abbreviated sha never sends dedup (the server would 400 it)", () => {
  const { requests, code, out } = runAction({
    event: { pull_request: { number: 12, head: { sha: "abc1234", repo: { full_name: "octo-org/widget-app" } } } },
    spec: [
      ...prContent(),
      enqueued("app"),
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  const body = bodyOf(requests, TRIGGER);
  assert.equal(body.sha, "abc1234");
  assert.ok(!("dedup" in body), "dedup must be omitted for a non-full sha");
});

test("title, body, and diff are capped before they ride", () => {
  const { requests, code, out } = runAction({
    event: prEvent,
    spec: [
      { url: "/pulls/12", times: 1, json: { title: "T".repeat(400), body: "B".repeat(11_000) } },
      { url: "/pulls/12", times: 1, text: "d".repeat(7_000) },
      enqueued("app"),
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  const body = bodyOf(requests, TRIGGER);
  assert.equal(body.title.length, 300);
  assert.equal(body.body.length, 10_000);
  assert.equal(body.diff.length, 6_000);
});

test("a 406-withheld diff still renders: the one call ships title and body alone", () => {
  const { code, requests, out } = runAction({
    env: pushEnv,
    spec: [
      { url: "/commits/", json: [{ number: 7, state: "open" }] },
      { url: "/pulls/7", times: 1, json: { title: "Add widget", body: "adds it" } },
      { url: "/pulls/7", times: 1, status: 406, json: { message: "Sorry, the diff exceeded the maximum" } },
      enqueued("action", "rnd_n"),
      { url: "/v1/renders/rnd_n/comment", json: { outcome: "ready", post: true, body: "b" } },
      { url: "/v1/renders/rnd_n", json: { status: "done" } },
      { url: "/issues/7/comments", method: "POST", status: 201, json: {} },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /withheld the diff/);
  const body = bodyOf(requests, TRIGGER);
  assert.equal(body.title, "Add widget");
  assert.equal(body.body, "adds it");
  assert.ok(!("diff" in body));
});

test("a non-406 diff failure fails loudly before any render is submitted", () => {
  const { code, requests, out } = runAction({
    env: pushEnv,
    spec: [
      { url: "/commits/", json: [{ number: 7, state: "open" }] },
      { url: "/pulls/7", times: 1, json: { title: "Add widget" } },
      { url: "/pulls/7", times: 1, status: 403, json: { message: "Resource not accessible" } },
    ],
  });
  assert.equal(code, 1, out);
  assert.match(out, /fetching the PR diff failed \(403\)/);
  assertIntakes(requests, 0);
});

// ─── deployment selection ───────────────────────────────────────────────────

test("no url input: waits for the deployment, then hands its URL to the one call", () => {
  const { requests, code, out } = runAction({
    event: prEvent,
    env: { RENDER_URL: "" },
    spec: [
      ...prContent(),
      { url: `/deployments?sha=${SHA}`, json: [{ id: 31 }] },
      { url: "/deployments/31/statuses", json: [{ state: "success", environment_url: "https://deploy-preview.example.test" }] },
      enqueued("app"),
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(bodyOf(requests, TRIGGER).url, "https://deploy-preview.example.test");
  const order = requests.map((r) => r.url);
  assert.ok(
    order.findIndex((u) => u.includes("/deployments")) < order.findIndex((u) => u.includes(TRIGGER)),
    "the deploy URL must resolve before the render is submitted",
  );
});

test("no url input and the only deploy FAILED: red check says the deploy failed, not 'no URL'", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    env: { RENDER_URL: "", WAIT_TIMEOUT_MS: "60" },
    spec: [
      ...prContent(),
      { url: `/deployments?sha=${SHA}`, json: [{ id: 51 }] },
      { url: "/deployments/51/statuses", json: [{ state: "failure", environment_url: "https://dead.example.test" }] },
    ],
  });
  assert.equal(code, 1, out);
  assert.match(out, /FAILED on your host/);
  assert.ok(!out.includes("advertised a URL"), "the generic no-URL copy must not show for a failed deploy");
  assertIntakes(requests, 0);
});

test("selection: a success whose only URL is the log page is never picked; the next round's environment_url wins", () => {
  const { code, requests, out } = runAction({
    event: prEvent,
    env: { RENDER_URL: "" },
    spec: [
      ...prContent(),
      { url: `/deployments?sha=${SHA}`, times: 1, json: [{ id: 41, created_at: "2026-01-01T00:00:00Z" }] },
      { url: `/deployments?sha=${SHA}`, json: [
        { id: 41, created_at: "2026-01-01T00:00:00Z" },
        { id: 42, created_at: "2026-01-01T00:05:00Z" },
      ] },
      { url: "/deployments/41/statuses", json: [
        { state: "success", environment_url: "", target_url: "https://ci.example.test/log/41", created_at: "2026-01-01T00:01:00Z" },
      ] },
      { url: "/deployments/42/statuses", json: [
        { state: "success", environment_url: "https://preview-42.example.test", target_url: "https://ci.example.test/log/42", created_at: "2026-01-01T00:06:00Z" },
      ] },
      enqueued("app"),
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(bodyOf(requests, TRIGGER).url, "https://preview-42.example.test");
});

test("selection: a deployment retired to inactive loses to one currently succeeded, whatever is newer", () => {
  const { code, requests, out } = runAction({
    event: prEvent,
    env: { RENDER_URL: "" },
    spec: [
      ...prContent(),
      { url: `/deployments?sha=${SHA}`, json: [
        { id: 51, created_at: "2026-01-01T00:10:00Z" },
        { id: 52, created_at: "2026-01-01T00:00:00Z" },
      ] },
      { url: "/deployments/51/statuses", json: [
        { state: "inactive", environment_url: "", created_at: "2026-01-01T00:20:00Z" },
        { state: "success", environment_url: "https://sub-app.example.test/storybook", created_at: "2026-01-01T00:11:00Z" },
      ] },
      { url: "/deployments/52/statuses", json: [
        { state: "success", environment_url: "https://site.example.test", created_at: "2026-01-01T00:01:00Z" },
      ] },
      enqueued("app"),
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(bodyOf(requests, TRIGGER).url, "https://site.example.test");
});

test("selection: when every deployment is retired, the retired success URL still serves (tier B)", () => {
  const { code, requests, out } = runAction({
    event: prEvent,
    env: { RENDER_URL: "" },
    spec: [
      ...prContent(),
      { url: `/deployments?sha=${SHA}`, json: [{ id: 61, created_at: "2026-01-01T00:00:00Z" }] },
      { url: "/deployments/61/statuses", json: [
        { state: "inactive", environment_url: "", created_at: "2026-01-01T00:20:00Z" },
        { state: "success", environment_url: "https://retired-preview.example.test", created_at: "2026-01-01T00:01:00Z" },
      ] },
      enqueued("app"),
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(bodyOf(requests, TRIGGER).url, "https://retired-preview.example.test");
});

test("selection: deployments are sorted client-side, so an oldest-first API order still yields the newest", () => {
  const { code, requests, out } = runAction({
    event: prEvent,
    env: { RENDER_URL: "" },
    spec: [
      ...prContent(),
      { url: `/deployments?sha=${SHA}`, json: [
        { id: 71, created_at: "2026-01-01T00:00:00Z" },
        { id: 72, created_at: "2026-01-01T00:10:00Z" },
      ] },
      { url: "/deployments/71/statuses", json: [
        { state: "success", environment_url: "https://old-preview.example.test", created_at: "2026-01-01T00:01:00Z" },
      ] },
      { url: "/deployments/72/statuses", json: [
        { state: "success", environment_url: "https://new-preview.example.test", created_at: "2026-01-01T00:11:00Z" },
      ] },
      enqueued("app"),
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(bodyOf(requests, TRIGGER).url, "https://new-preview.example.test");
});

test("selection: with every deployment retired, the NEWEST retired URL wins", () => {
  const { code, requests, out } = runAction({
    event: prEvent,
    env: { RENDER_URL: "" },
    spec: [
      ...prContent(),
      { url: `/deployments?sha=${SHA}`, json: [
        { id: 91, created_at: "2026-01-01T00:10:00Z" },
        { id: 92, created_at: "2026-01-01T00:00:00Z" },
      ] },
      { url: "/deployments/91/statuses", json: [
        { state: "inactive", environment_url: "", created_at: "2026-01-01T00:30:00Z" },
        { state: "success", environment_url: "https://retired-new.example.test", created_at: "2026-01-01T00:11:00Z" },
      ] },
      { url: "/deployments/92/statuses", json: [
        { state: "inactive", environment_url: "", created_at: "2026-01-01T00:29:00Z" },
        { state: "success", environment_url: "https://retired-old.example.test", created_at: "2026-01-01T00:01:00Z" },
      ] },
      enqueued("app"),
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(bodyOf(requests, TRIGGER).url, "https://retired-new.example.test");
});

// ─── polling, forks, and inputs ─────────────────────────────────────────────

test("poll errors are transient: a 429 mid-poll still reaches done and exits 0", () => {
  const { code, out } = runAction({
    event: prEvent,
    spec: [
      ...prContent(),
      enqueued("app"),
      { url: "/v1/renders/rnd_1", times: 1, status: 429, json: { error: { code: "rate_limited", message: "slow down" } } },
      { url: "/v1/renders/rnd_1", times: 1, text: "not json" },
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /poll error \(429\)/);
});

test("render-timeout 0 still reads a finished render: the poll runs before any sleep or expiry", () => {
  const { code, out } = runAction({
    event: prEvent,
    env: { RENDER_TIMEOUT: "0" },
    spec: [
      ...prContent(),
      enqueued("app"),
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /finished \(done\)/);
});

// Smoke only: a negative interval clamps to 1ms in code; behaviorally a hot
// loop still terminates here, so this pins "the sleep path runs and the run
// completes", not the clamp value itself.
test("a negative poll-interval override still polls through running to done", () => {
  const { code, out } = runAction({
    event: prEvent,
    env: { POLL_INTERVAL_MS: "-5" },
    spec: [
      ...prContent(),
      enqueued("app"),
      { url: "/v1/renders/rnd_1", times: 2, json: { status: "running" } },
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /finished \(done\)/);
});

test("a fork PR skips quietly even when a key is present, making zero requests", () => {
  const { code, out, requests } = runAction({
    event: { pull_request: { number: 12, head: { sha: SHA, repo: { full_name: "stranger/widget-app-fork" } } } },
    spec: [],
  });
  assert.equal(code, 0, out);
  assert.match(out, /fork/);
  assert.equal(requests.length, 0);
});

test("a deleted fork (head.repo null) still reads as a fork and skips", () => {
  const { code, out, requests } = runAction({
    event: { pull_request: { number: 12, head: { sha: SHA, repo: null } } },
    spec: [],
  });
  assert.equal(code, 0, out);
  assert.match(out, /fork/);
  assert.equal(requests.length, 0);
});

test("pull_request_target is never treated as a fork skip (it carries secrets by design)", () => {
  const { code, out, requests } = runAction({
    event: { pull_request: { number: 12, head: { sha: SHA, repo: { full_name: "stranger/widget-app-fork" } }, base: { repo: { full_name: "octo-org/widget-app" } } } },
    env: { GITHUB_EVENT_NAME: "pull_request_target" },
    spec: [
      ...prContent(),
      enqueued("app"),
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(hits(requests, TRIGGER).length, 1, "the run must proceed, not fork-skip");
});

test("a same-repo PR with a genuinely missing key still fails loudly", () => {
  const { code, out } = runAction({
    event: { pull_request: { number: 12, head: { sha: SHA, repo: { full_name: "octo-org/widget-app" } } } },
    env: { DUCKY_API_KEY: "" },
    spec: [],
  });
  assert.equal(code, 1, out);
  assert.match(out, /api-key/);
});

// FULL_SHA re-exported check keeps helpers honest about what the fixtures use.
test("fixture sha is full-length so dedup applies on the happy path", () => {
  assert.match(FULL_SHA, /^[0-9a-f]{40}$/);
});
