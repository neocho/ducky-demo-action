// The handoff-and-fallback contract, pinned. Every case runs the real
// index.mjs as a subprocess against a scripted Ducky/GitHub API (fetch-stub),
// so exit codes, ordering, and request bodies are asserted end to end.

import assert from "node:assert/strict";
import { test } from "node:test";
import { API, SHA, bodyOf, hits, runAction, SHA as FULL_SHA } from "./helpers.mjs";

const TRIGGER = "/v1/github/trigger/octo-org/widget-app";
const NO_OPEN_PR = "no open PR has this commit at its head";

const prEvent = { pull_request: { number: 12, head: { sha: SHA, repo: { full_name: "octo-org/widget-app" } } } };

// A complete self-render script: PR resolution (merged PR #7), the combined
// derive+create call, poll, the served comment, post. Fallback cases splice a
// trigger rule ahead. The comment rule sits BEFORE the poll rule: rules
// substring-match in order and the poll URL is a prefix of the comment URL.
const COMPOSED_BODY = "### 🦆 Ducky demo\n\ncomposed by the server";
const fallbackSpec = [
  { url: "/commits/", json: [{ number: 7, state: "closed" }] },
  { url: "/pulls/7", times: 1, json: { title: "Add widget", body: "adds a widget" } },
  { url: "/pulls/7", times: 1, text: "diff --git a/widget.js b/widget.js" },
  { url: "/v1/renders/from-pr", method: "POST", status: 202, json: { id: "rnd_fallback", status: "queued" } },
  { url: "/v1/renders/rnd_fallback/comment", json: { outcome: "ready", post: true, body: COMPOSED_BODY } },
  { url: "/v1/renders/rnd_fallback", json: { status: "done", demo_url: "https://cdn.example.test/demo.mp4" } },
  { url: "/issues/7/comments", method: "POST", status: 201, json: {} },
];
const pushEnv = { GITHUB_EVENT_NAME: "push" };

test("handoff enqueued: polls to done, posts nothing, calls no GitHub API", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    env: { PR_NUMBER: "12" },
    spec: [
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
      { url: "/v1/renders/rnd_1", times: 2, json: { status: "running" } },
      { url: "/v1/renders/rnd_1", json: { status: "done", demo_url: "https://cdn.example.test/demo.mp4" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /handed off to the Ducky GitHub App/);
  assert.match(out, /finished \(done\)/, "must reach the terminal poll, not the expiry branch");
  assert.equal(hits(requests, "api.github.com").length, 0, "handoff path must not touch the GitHub API");
  assert.equal(hits(requests, "/issues/").length, 0, "handoff path must not post a comment");
  const trigger = bodyOf(requests, TRIGGER);
  assert.equal(trigger.sha, SHA);
  assert.equal(trigger.url, "https://preview.example.test");
  assert.equal(trigger.dedup, true);
  assert.equal(trigger.reel, true);
});

test("handoff render failed: exits non-zero", () => {
  const { code, out } = runAction({
    event: prEvent,
    spec: [
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
      { url: "/v1/renders/rnd_1", json: { status: "failed" } },
    ],
  });
  assert.equal(code, 1, out);
  assert.match(out, /render failed/);
});

test("handoff poll budget expiry: exits 0 with no comment (the App still posts)", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    env: { RENDER_TIMEOUT: "1" },
    spec: [
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
      { url: "/v1/renders/rnd_1", json: { status: "running" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /poll budget expired/);
  assert.equal(hits(requests, "/issues/").length, 0);
});

test("skipped with the no-open-PR reason: falls back, resolves the merged PR, posts its own comment", () => {
  const { code, out, requests } = runAction({
    env: pushEnv,
    spec: [
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: NO_OPEN_PR, render_id: "rnd_skip" } },
      ...fallbackSpec,
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /rendering from the Action/);
  assert.equal(hits(requests, "/issues/7/comments").length, 1, "fallback must post the comment");
  assert.equal(bodyOf(requests, "/issues/7/comments").body, COMPOSED_BODY, "the served body posts verbatim");
  assert.equal(hits(requests, "/from-pr").length, 1, "exactly one submission");
  // strict order: submit, then poll to terminal, then the comment fetch, then the post
  const urls = requests.map((r) => r.url);
  const iSubmit = urls.findIndex((u) => u.includes("/from-pr"));
  const iComment = urls.findIndex((u) => u.includes("/rnd_fallback/comment"));
  const iPost = urls.findIndex((u) => u.includes("/issues/7/comments"));
  const iPoll = urls.findIndex((u) => u.includes("/rnd_fallback") && !u.includes("/comment"));
  assert.ok(iSubmit < iPoll && iPoll < iComment && iComment < iPost, `order was ${urls.join(" -> ")}`);
  // B6: the PR description ships with the content
  assert.equal(bodyOf(requests, "/from-pr").body, "adds a widget");
});

test("skipped with code no_open_pr: falls back even when the reason copy changes", () => {
  const { code, requests, out } = runAction({
    env: pushEnv,
    spec: [
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: "reworded on some future server", code: "no_open_pr" } },
      ...fallbackSpec,
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(hits(requests, "/issues/7/comments").length, 1);
});

test("skipped not-demoable: exits 0 and does NOT self-render (the App posted the skip note)", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: "copy-only change, nothing user-visible", render_id: "rnd_note" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /skipped by the Ducky GitHub App/);
  assert.equal(hits(requests, "/v1/renders").length, 0, "a not-demoable skip must not fall back");
  assert.equal(hits(requests, "/issues/").length, 0);
});

test("skipped commit-already-rendered (dedup hit): exits 0 without a second render", () => {
  const { code, requests, out } = runAction({
    event: prEvent,
    spec: [
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: "commit already rendered", render_id: "rnd_prior" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(hits(requests, "/v1/renders").length, 0);
});

test("404 (no covering install): falls back to self-render end to end", () => {
  const { code, requests, out } = runAction({
    env: pushEnv,
    spec: [
      { url: TRIGGER, method: "POST", status: 404, json: { error: { code: "not_found", message: "no GitHub App installation covers that repo" } } },
      ...fallbackSpec,
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(hits(requests, "/issues/7/comments").length, 1);
});

test("403: falls back like 404", () => {
  const { code, out } = runAction({
    env: pushEnv,
    spec: [
      { url: TRIGGER, method: "POST", status: 403, json: { error: { code: "forbidden", message: "no enabled GitHub installation covers that repo" } } },
      ...fallbackSpec,
    ],
  });
  assert.equal(code, 0, out);
});

test("429 (daily cap): exits non-zero and never falls back", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [
      { url: TRIGGER, method: "POST", status: 429, json: { error: { code: "rate_limited", message: "Daily render cap reached" } } },
    ],
  });
  assert.equal(code, 1, out);
  assert.equal(hits(requests, "/v1/renders").length, 0, "an at-cap run must stay a red check, not a second render");
});

test("401 (bad key): fails loudly with no fallback", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [
      { url: TRIGGER, method: "POST", status: 401, json: { error: { code: "unauthorized", message: "Invalid API key" } } },
    ],
  });
  assert.equal(code, 1, out);
  assert.match(out, /401/);
  assert.equal(hits(requests, "/v1/renders").length, 0);
});

test("400 (caller bug): fails loudly rather than masking it behind the fallback", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [
      { url: TRIGGER, method: "POST", status: 400, json: { error: { code: "invalid_request", message: "url rejected: not public" } } },
    ],
  });
  assert.equal(code, 1, out);
  assert.equal(hits(requests, "/v1/renders").length, 0);
});

test("5xx from the trigger: logs the fallback and self-renders", () => {
  const { code, out, requests } = runAction({
    env: pushEnv,
    spec: [
      { url: TRIGGER, method: "POST", status: 500, json: { error: { code: "internal", message: "Internal server error" } } },
      ...fallbackSpec,
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /trigger failed \(500\), falling back/);
  assert.equal(hits(requests, "/issues/7/comments").length, 1);
});

test("5xx from the trigger AND the fallback (whole API down): the check goes red", () => {
  const { code, out } = runAction({
    env: pushEnv,
    spec: [
      { url: TRIGGER, method: "POST", status: 500, json: {} },
      { url: "/commits/", json: [{ number: 7, state: "closed" }] },
      { url: "/pulls/7", times: 1, json: { title: "Add widget" } },
      { url: "/pulls/7", times: 1, text: "diff" },
      { url: "/v1/renders/from-pr", method: "POST", status: 500, json: { error: { code: "internal", message: "Internal server error" } } },
    ],
  });
  assert.equal(code, 1, out);
});

test("network error on the trigger: falls back", () => {
  const { code, out } = runAction({
    env: pushEnv,
    spec: [
      { url: TRIGGER, method: "POST", network_error: "connect ECONNREFUSED" },
      ...fallbackSpec,
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /trigger unreachable/);
});

test("explicit task and credential labels ride the trigger body verbatim", () => {
  const { requests, code, out } = runAction({
    event: prEvent,
    env: {
      RENDER_TASK: "Show the new checkout flow",
      RENDER_CREDENTIAL: "staging-login",
      RENDER_VERCEL_BYPASS: "bypass-1",
      RENDER_LOGIN_HINTS: "/enter, /portal",
    },
    spec: [
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  const body = bodyOf(requests, TRIGGER);
  assert.equal(body.task, "Show the new checkout flow");
  assert.equal(body.credential, "staging-login");
  assert.equal(body.vercel_bypass, "bypass-1");
  assert.deepEqual(body.login_hints, ["/enter", "/portal"]);
});

test("an abbreviated sha never sends dedup (the server would 400 it)", () => {
  const { requests, code, out } = runAction({
    event: { pull_request: { number: 12, head: { sha: "abc1234", repo: { full_name: "octo-org/widget-app" } } } },
    spec: [
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  const body = bodyOf(requests, TRIGGER);
  assert.equal(body.sha, "abc1234");
  assert.ok(!("dedup" in body), "dedup must be omitted for a non-full sha");
});

test("no url input: waits for the deployment, then hands its URL to the trigger", () => {
  const { requests, code, out } = runAction({
    event: prEvent,
    env: { RENDER_URL: "" },
    spec: [
      { url: `/deployments?sha=${SHA}`, json: [{ id: 31 }] },
      { url: "/deployments/31/statuses", json: [{ state: "success", environment_url: "https://deploy-preview.example.test" }] },
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  const body = bodyOf(requests, TRIGGER);
  assert.equal(body.url, "https://deploy-preview.example.test");
  const order = requests.map((r) => r.url);
  assert.ok(
    order.findIndex((u) => u.includes("/deployments")) < order.findIndex((u) => u.includes(TRIGGER)),
    "deploy URL must resolve before the handoff",
  );
});

test("handoff path resolves no PR and derives nothing: zero commits/pulls or derive calls", () => {
  const { requests, code, out } = runAction({
    event: prEvent,
    spec: [
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(hits(requests, "/commits/").length, 0);
  assert.equal(hits(requests, "/v1/derive").length, 0);
});

// FULL_SHA re-exported check keeps helpers honest about what the fixtures use.
test("fixture sha is full-length so dedup applies on the happy path", () => {
  assert.match(FULL_SHA, /^[0-9a-f]{40}$/);
});

test("a 200 with a non-JSON body fails loudly instead of reading as a skip", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [{ url: TRIGGER, method: "POST", status: 200, text: "<html>gateway error</html>" }],
  });
  assert.equal(code, 1, out);
  assert.match(out, /unexpected trigger response/);
  assert.equal(hits(requests, "/v1/renders").length, 0);
});

test("a 200 with an empty object fails loudly instead of exiting green", () => {
  const { code, out } = runAction({
    event: prEvent,
    spec: [{ url: TRIGGER, method: "POST", status: 200, json: {} }],
  });
  assert.equal(code, 1, out);
  assert.match(out, /unexpected trigger response/);
});

test("a 202 without a render id fails loudly instead of polling nothing", () => {
  const { code, out, requests } = runAction({
    event: prEvent,
    spec: [{ url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", pr_number: 12 } }],
  });
  assert.equal(code, 1, out);
  assert.match(out, /unexpected body/);
  assert.equal(hits(requests, "/v1/renders/").length, 0, "must not poll without an id");
});

test("poll errors are transient: a 429 mid-poll still reaches done and exits 0", () => {
  const { code, out } = runAction({
    event: prEvent,
    spec: [
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
      { url: "/v1/renders/rnd_1", times: 1, status: 429, json: { error: { code: "rate_limited", message: "slow down" } } },
      { url: "/v1/renders/rnd_1", times: 1, text: "not json" },
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /poll error \(429\)/);
});

test("handoff whose polls ALL fail goes red, never a silent green", () => {
  const { code, out } = runAction({
    event: prEvent,
    env: { RENDER_TIMEOUT: "1" },
    spec: [
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
      { url: "/v1/renders/rnd_1", status: 500, json: { error: { code: "internal", message: "Internal server error" } } },
    ],
  });
  assert.equal(code, 1, out);
  assert.match(out, /could not read its status even once/);
});

test("a present code decides alone: stale no-open-PR reason text does not trigger the fallback", () => {
  const { code, requests, out } = runAction({
    event: prEvent,
    spec: [
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: NO_OPEN_PR, code: "not_demoable" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(hits(requests, "/v1/renders").length, 0, "code wins over the legacy reason match");
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

test("a same-repo PR with a genuinely missing key still fails loudly", () => {
  const { code, out } = runAction({
    event: { pull_request: { number: 12, head: { sha: SHA, repo: { full_name: "octo-org/widget-app" } } } },
    env: { DUCKY_API_KEY: "" },
    spec: [],
  });
  assert.equal(code, 1, out);
  assert.match(out, /api-key/);
});

test("selection: a success whose only URL is the log page is never picked; the next round's environment_url wins", () => {
  const { code, requests, out } = runAction({
    event: prEvent,
    env: { RENDER_URL: "" },
    spec: [
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
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  const body = bodyOf(requests, TRIGGER);
  assert.equal(body.url, "https://preview-42.example.test");
});

test("selection: a deployment retired to inactive loses to one currently succeeded, whatever is newer", () => {
  const { code, requests, out } = runAction({
    event: prEvent,
    env: { RENDER_URL: "" },
    spec: [
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
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
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
      { url: `/deployments?sha=${SHA}`, json: [{ id: 61, created_at: "2026-01-01T00:00:00Z" }] },
      { url: "/deployments/61/statuses", json: [
        { state: "inactive", environment_url: "", created_at: "2026-01-01T00:20:00Z" },
        { state: "success", environment_url: "https://retired-preview.example.test", created_at: "2026-01-01T00:01:00Z" },
      ] },
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
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
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(bodyOf(requests, TRIGGER).url, "https://new-preview.example.test");
});

test("render-timeout 0 still reads a finished render: the poll runs before any sleep or expiry", () => {
  const { code, out } = runAction({
    event: prEvent,
    env: { RENDER_TIMEOUT: "0" },
    spec: [
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /finished \(done\)/);
});

test("fallback render-timeout expiry: posts the past-tense note and exits 0", () => {
  const { code, out, requests } = runAction({
    env: { ...pushEnv, RENDER_TIMEOUT: "0" },
    spec: [
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: NO_OPEN_PR } },
      { url: "/commits/", json: [{ number: 7, state: "closed" }] },
      { url: "/pulls/7", times: 1, json: { title: "Add widget" } },
      { url: "/pulls/7", times: 1, text: "diff" },
      { url: "/v1/renders/from-pr", method: "POST", status: 202, json: { id: "rnd_slow", status: "queued" } },
      { url: "/v1/renders/rnd_slow", json: { status: "running" } },
      { url: "/issues/7/comments", method: "POST", status: 201, json: {} },
    ],
  });
  assert.equal(code, 0, out);
  const note = bodyOf(requests, "/issues/7/comments");
  assert.match(note.body, /still rendering when this check finished/);
  assert.match(out, /render-timeout/);
  assert.equal(hits(requests, "/rnd_slow/comment").length, 0, "no comment fetch on the timeout path");
});

// Smoke only: a negative interval clamps to 1ms in code; behaviorally a hot
// loop still terminates here, so this pins "the sleep path runs and the run
// completes", not the clamp value itself.
test("a negative poll-interval override still polls through running to done", () => {
  const { code, out } = runAction({
    event: prEvent,
    env: { POLL_INTERVAL_MS: "-5" },
    spec: [
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
      { url: "/v1/renders/rnd_1", times: 2, json: { status: "running" } },
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /finished \(done\)/);
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
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(hits(requests, TRIGGER).length, 1, "the run must proceed, not fork-skip");
});

test("self-render whose polls ALL fail goes red with no false note", () => {
  const { code, out, requests } = runAction({
    env: { ...pushEnv, RENDER_TIMEOUT: "1" },
    spec: [
      { url: TRIGGER, method: "POST", status: 404, json: { error: { code: "not_found", message: "no GitHub App installation covers that repo" } } },
      { url: "/commits/", json: [{ number: 7, state: "closed" }] },
      { url: "/pulls/7", times: 1, json: { title: "Add widget" } },
      { url: "/pulls/7", times: 1, text: "diff" },
      { url: "/v1/renders/from-pr", method: "POST", status: 202, json: { id: "rnd_x", status: "queued" } },
      { url: "/v1/renders/rnd_x", status: 500, json: { error: { code: "internal", message: "Internal server error" } } },
    ],
  });
  assert.equal(code, 1, out);
  assert.match(out, /could not be read even once/);
  assert.equal(hits(requests, "/issues/").length, 0, "no note may be posted about a render never observed");
});

test("a failed note POST logs honestly and still exits 0", () => {
  const { code, out } = runAction({
    env: { ...pushEnv, RENDER_TIMEOUT: "0" },
    spec: [
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: NO_OPEN_PR } },
      { url: "/commits/", json: [{ number: 7, state: "closed" }] },
      { url: "/pulls/7", times: 1, json: { title: "Add widget" } },
      { url: "/pulls/7", times: 1, text: "diff" },
      { url: "/v1/renders/from-pr", method: "POST", status: 202, json: { id: "rnd_slow", status: "queued" } },
      { url: "/v1/renders/rnd_slow", json: { status: "running" } },
      { url: "/issues/7/comments", method: "POST", status: 403, json: { message: "Resource not accessible by integration" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /could not post the note/);
});

test("an explicit task still ships the PR content, so claims and description reach the row", () => {
  const { code, requests, out } = runAction({
    env: { ...pushEnv, RENDER_TASK: "Show the new checkout flow" },
    spec: [
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: NO_OPEN_PR, code: "no_open_pr" } },
      ...fallbackSpec,
    ],
  });
  assert.equal(code, 0, out);
  const body = bodyOf(requests, "/from-pr");
  assert.equal(body.task, "Show the new checkout flow");
  assert.equal(body.title, "Add widget");
  assert.match(body.diff, /^diff --git/);
  assert.equal(hits(requests, "/v1/derive").length, 0, "the split derive call is gone");
});

test("a judged no-demo from the combined call exits 0 with no render, no poll, no comment", () => {
  const { code, out, requests } = runAction({
    env: pushEnv,
    spec: [
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: NO_OPEN_PR, code: "no_open_pr" } },
      { url: "/commits/", json: [{ number: 7, state: "closed" }] },
      { url: "/pulls/7", times: 1, json: { title: "Add widget" } },
      { url: "/pulls/7", times: 1, text: "diff" },
      { url: "/v1/renders/from-pr", method: "POST", status: 200, json: { status: "skipped", code: "not_demoable", reason: "copy-only change" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /nothing user-visible to demo/);
  assert.equal(hits(requests, "/v1/renders/from-pr").length, 1, "the one submission is the only render call");
  assert.equal(hits(requests, "/issues/").length, 0);
  const submitAt = requests.findIndex((r) => r.url.includes("/from-pr"));
  assert.equal(requests.slice(submitAt + 1).filter((r) => r.url.includes("/v1/renders/")).length, 0, "nothing to poll after a no-render skip");
});

test("a held render posts the served held note verbatim and stays green", () => {
  const heldBody = "### 🦆 Ducky demo held\n\nheld note";
  const { code, requests, out } = runAction({
    env: pushEnv,
    spec: [
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: NO_OPEN_PR, code: "no_open_pr" } },
      { url: "/commits/", json: [{ number: 7, state: "closed" }] },
      { url: "/pulls/7", times: 1, json: { title: "Add widget" } },
      { url: "/pulls/7", times: 1, text: "diff" },
      { url: "/v1/renders/from-pr", method: "POST", status: 202, json: { id: "rnd_h", status: "queued" } },
      { url: "/v1/renders/rnd_h/comment", json: { outcome: "held", post: true, body: heldBody } },
      { url: "/v1/renders/rnd_h", json: { status: "done" } },
      { url: "/issues/7/comments", method: "POST", status: 201, json: {} },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(bodyOf(requests, "/issues/7/comments").body, heldBody);
});

test("a failed render posts the served failure note and the check goes red", () => {
  const failBody = "### 🦆 Couldn't render the demo";
  const { code, requests, out } = runAction({
    env: pushEnv,
    spec: [
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: NO_OPEN_PR, code: "no_open_pr" } },
      { url: "/commits/", json: [{ number: 7, state: "closed" }] },
      { url: "/pulls/7", times: 1, json: { title: "Add widget" } },
      { url: "/pulls/7", times: 1, text: "diff" },
      { url: "/v1/renders/from-pr", method: "POST", status: 202, json: { id: "rnd_f", status: "queued" } },
      { url: "/v1/renders/rnd_f/comment", json: { outcome: "failed", post: true, body: failBody } },
      { url: "/v1/renders/rnd_f", json: { status: "failed" } },
      { url: "/issues/7/comments", method: "POST", status: 201, json: {} },
    ],
  });
  assert.equal(code, 1, out);
  assert.equal(bodyOf(requests, "/issues/7/comments").body, failBody, "the failure note posts before the red exit");
});

test("an unreachable comment endpoint exits by render status with no invented body", () => {
  const { code, requests, out } = runAction({
    env: pushEnv,
    spec: [
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: NO_OPEN_PR, code: "no_open_pr" } },
      { url: "/commits/", json: [{ number: 7, state: "closed" }] },
      { url: "/pulls/7", times: 1, json: { title: "Add widget" } },
      { url: "/pulls/7", times: 1, text: "diff" },
      { url: "/v1/renders/from-pr", method: "POST", status: 202, json: { id: "rnd_d", status: "queued" } },
      { url: "/v1/renders/rnd_d/comment", status: 500, json: {} },
      { url: "/v1/renders/rnd_d", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /could not fetch the composed comment/);
  assert.equal(hits(requests, "/issues/").length, 0);
});

test("a non-406 diff failure fails loudly before any render is submitted", () => {
  const { code, requests, out } = runAction({
    env: pushEnv,
    spec: [
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: NO_OPEN_PR, code: "no_open_pr" } },
      { url: "/commits/", json: [{ number: 7, state: "closed" }] },
      { url: "/pulls/7", times: 1, json: { title: "Add widget" } },
      { url: "/pulls/7", times: 1, status: 403, json: { message: "Resource not accessible" } },
    ],
  });
  assert.equal(code, 1, out);
  assert.match(out, /fetching the PR diff failed \(403\)/);
  assert.equal(hits(requests, "/from-pr").length, 0);
});

test("a 406-withheld diff still renders: the combined call ships title and body alone", () => {
  const { code, requests, out } = runAction({
    env: pushEnv,
    spec: [
      { url: TRIGGER, method: "POST", status: 200, json: { status: "skipped", reason: NO_OPEN_PR, code: "no_open_pr" } },
      { url: "/commits/", json: [{ number: 7, state: "closed" }] },
      { url: "/pulls/7", times: 1, json: { title: "Add widget", body: "adds it" } },
      { url: "/pulls/7", times: 1, status: 406, json: { message: "Sorry, the diff exceeded the maximum" } },
      { url: "/v1/renders/from-pr", method: "POST", status: 202, json: { id: "rnd_n", status: "queued" } },
      { url: "/v1/renders/rnd_n/comment", json: { outcome: "ready", post: true, body: "b" } },
      { url: "/v1/renders/rnd_n", json: { status: "done" } },
      { url: "/issues/7/comments", method: "POST", status: 201, json: {} },
    ],
  });
  assert.equal(code, 0, out);
  assert.match(out, /withheld the diff/);
  const body = bodyOf(requests, "/from-pr");
  assert.equal(body.title, "Add widget");
  assert.ok(!("diff" in body));
});

test("selection: with every deployment retired, the NEWEST retired URL wins", () => {
  const { code, requests, out } = runAction({
    event: prEvent,
    env: { RENDER_URL: "" },
    spec: [
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
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
  assert.equal(bodyOf(requests, TRIGGER).url, "https://retired-new.example.test");
});
