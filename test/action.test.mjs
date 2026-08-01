// The handoff-and-fallback contract, pinned. Every case runs the real
// index.mjs as a subprocess against a scripted Ducky/GitHub API (fetch-stub),
// so exit codes, ordering, and request bodies are asserted end to end.

import assert from "node:assert/strict";
import { test } from "node:test";
import { API, SHA, bodyOf, hits, runAction, SHA as FULL_SHA } from "./helpers.mjs";

const TRIGGER = "/v1/github/trigger/octo-org/widget-app";
const NO_OPEN_PR = "no open PR has this commit at its head";

const prEvent = { pull_request: { number: 12, head: { sha: SHA } }, title: undefined };

// A complete self-render script: PR resolution (merged PR #7), derive,
// render submit, poll, comment. Fallback cases splice a trigger rule ahead.
const fallbackSpec = [
  { url: "/commits/", json: [{ number: 7, state: "closed" }] },
  { url: "/pulls/7", times: 1, json: { title: "Add widget", body: "adds a widget" } },
  { url: "/pulls/7", times: 1, text: "diff --git a/widget.js b/widget.js" },
  { url: "/v1/derive", method: "POST", json: { demoable: true, task: "Show the widget" } },
  { url: "/v1/renders", method: "POST", json: { id: "rnd_fallback" } },
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
  assert.ok(bodyOf(requests, "/v1/renders"), "fallback must self-render");
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
      { url: "/v1/derive", method: "POST", json: { demoable: true, task: "Show the widget" } },
      { url: "/v1/renders", method: "POST", status: 500, json: { error: { code: "internal", message: "Internal server error" } } },
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
    event: { pull_request: { number: 12, head: { sha: "abc1234" } } },
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

test("a negative poll-interval override clamps instead of hot-looping", () => {
  const { code, out } = runAction({
    event: prEvent,
    env: { POLL_INTERVAL_MS: "-5" },
    spec: [
      { url: TRIGGER, method: "POST", status: 202, json: { status: "enqueued", render_id: "rnd_1", pr_number: 12 } },
      { url: "/v1/renders/rnd_1", json: { status: "done" } },
    ],
  });
  assert.equal(code, 0, out);
});
