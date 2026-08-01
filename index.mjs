// Ducky Demo Action runtime.
//
// Reads inputs from env (mapped by action.yml), renders a demo via the Ducky
// API, and posts the video as a PR comment.
//   - Repos covered by the Ducky GitHub App hand the render to the App
//     (POST /v1/github/trigger/{owner}/{name}): one render, one comment,
//     posted by the App with its full proof table. The Action keeps the CI
//     signal: it polls the render and the check goes red if the render fails.
//   - Repos without the App (or pushes the App can't serve, like a merge
//     commit with no open PR) self-render exactly as before: the Action
//     renders and posts its own comment.
//   - No `url` input → waits for this commit's deployment (GitHub deployments
//     API) and renders its environment_url, so the demo always shows the PR's
//     actual code.
//   - No `task` input → sends the PR's title/body/diff to Ducky, which derives
//     what to demo, or says nothing user-visible changed (clean skip).
//   - Works on pull_request AND push events (the PR is resolved from the
//     commit when it's not in the event context).

import { readFileSync } from "node:fs";

const env = process.env;
const fail = (msg) => { console.log(`::error::Ducky: ${msg}`); process.exit(1); };

const KEY = env.DUCKY_API_KEY;
let URL_ = env.RENDER_URL;
let TASK = env.RENDER_TASK;
const REEL = env.RENDER_REEL !== "false"; // default true
// Stored-credential labels (never the secrets) + custom login-path hints,
// forwarded verbatim to the render.
const CREDENTIAL = env.RENDER_CREDENTIAL || undefined;
const VERCEL_BYPASS = env.RENDER_VERCEL_BYPASS || undefined;
const LOGIN_HINTS = (env.RENDER_LOGIN_HINTS || "")
  .split(",").map((h) => h.trim()).filter(Boolean);
const API = (env.DUCKY_API_BASE || "https://api.tryducky.dev").replace(/\/+$/, "");
let PR = env.PR_NUMBER;
const GH_TOKEN = env.GH_TOKEN;
const REPO = env.GH_REPO; // owner/repo
const WAIT_TIMEOUT_S = Math.max(30, parseInt(env.WAIT_TIMEOUT || "300", 10) || 300);

// Overridable so the test harness doesn't sit through real poll sleeps.
// Clamped to >=1ms so a bad value can never become a zero-delay hot loop.
const POLL_INTERVAL_MS = Math.max(1, parseInt(env.POLL_INTERVAL_MS || "", 10) || 20_000);
const DEPLOY_POLL_MS = Math.max(1, parseInt(env.DEPLOY_POLL_MS || "", 10) || 10_000);
const POLL_MAX = 30; // ~10 min cap
const DONE = ["done", "succeeded", "completed"];
const TERMINAL = [...DONE, "failed", "error", "cancelled", "skipped"];

// The commit dedup on the handoff compares full shas server-side, so an
// abbreviated sha would dedup nothing; only send the flag when it can work.
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
// The server's no-open-PR skip reason (matched exactly; `code` wins when the
// server sends one). Anything else skipped means the App owned the outcome.
const NO_OPEN_PR_REASON = "no open PR has this commit at its head";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GitHub REST call with the workflow token. Returns the Response. */
const gh = (path, accept = "application/vnd.github+json") =>
  fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28" },
  });

/** The workflow's event payload (already on disk; {} if unreadable). */
function readEvent() {
  try { return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")); } catch { return {}; }
}

/** The commit the deploy system builds: the PR's HEAD on pull_request events
 *  (GITHUB_SHA there is the synthetic merge commit, which hosts don't deploy),
 *  GITHUB_SHA otherwise (push). */
function headSha(event) {
  return event.pull_request?.head?.sha || env.GITHUB_SHA;
}

/** Resolve the PR to comment on from the commit (push events have no PR in
 *  context; works for merged PRs too). Only the self-render path needs a PR:
 *  the handoff posts nothing, so it never calls this. */
async function resolvePr(sha) {
  const res = await gh(`/repos/${REPO}/commits/${sha}/pulls`);
  if (!res.ok) fail(`resolving the PR for ${sha.slice(0, 7)} failed (${res.status})`);
  const prs = await res.json();
  if (!prs.length) {
    // A direct-to-main push with no associated PR has nothing to demo. Only push
    // events reach here (pull_request events carry their own PR), so skip quietly
    // (neutral, exit 0) instead of erroring with a red ✗ on every such commit.
    if (env.GITHUB_EVENT_NAME === "push") {
      console.log(`Ducky: no pull request for ${sha.slice(0, 7)}, skipping (direct push, nothing to demo).`);
      process.exit(0);
    }
    fail("no pull request found for this commit. Run on a PR event, or push a merged PR's commit.");
  }
  const open = prs.find((p) => p.state === "open");
  return String((open ?? prs[0]).number);
}

/** Wait for a successful deployment of `sha` and return its environment_url.
 *  Polls GitHub's deployments API, the universal record hosts like Vercel
 *  write when a preview finishes building. */
async function waitForDeployment(sha) {
  console.log(`Ducky: no url set, waiting for a deployment of ${sha.slice(0, 7)} (timeout ${WAIT_TIMEOUT_S}s)`);
  const deadline = Date.now() + WAIT_TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    const dRes = await gh(`/repos/${REPO}/deployments?sha=${sha}&per_page=10`);
    if (dRes.ok) {
      for (const d of await dRes.json()) {
        const sRes = await gh(`/repos/${REPO}/deployments/${d.id}/statuses?per_page=5`);
        if (!sRes.ok) continue;
        const ok = (await sRes.json()).find((s) => s.state === "success" && (s.environment_url || s.target_url));
        if (ok) {
          const url = ok.environment_url || ok.target_url;
          console.log(`Ducky: deployment ready, ${url}`);
          return url;
        }
      }
    }
    await sleep(DEPLOY_POLL_MS);
  }
  fail(`no successful deployment for ${sha.slice(0, 7)} within ${WAIT_TIMEOUT_S}s. Pass \`url\` explicitly, raise \`wait-timeout\`, or check the deploy.`);
}

/** Poll a render to a terminal state. Error responses and malformed bodies
 *  are transient (log and keep polling); `observed` reports whether a real
 *  render status was ever read, so an expiry where every poll failed is
 *  distinguishable from a render that is genuinely still running. */
async function pollRender(id) {
  let observed = false;
  for (let i = 0; i < POLL_MAX; i++) {
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(`${API}/v1/renders/${id}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) {
      console.log(`Ducky: poll error (${res.status}), retrying`);
      continue;
    }
    const r = await res.json().catch(() => null);
    if (!r || typeof r.status !== "string") {
      console.log("Ducky: poll returned an unexpected body, retrying");
      continue;
    }
    observed = true;
    console.log(`Ducky: ${r.status}`);
    if (TERMINAL.includes(r.status)) return { render: r, observed };
  }
  return { render: null, observed };
}

/** Offer the render to the Ducky GitHub App. When the App can serve this repo
 *  and commit, it renders and posts the comment itself; this function then
 *  owns the outcome and EXITS (0 on done/skipped, 1 on failed), posting
 *  nothing. It returns only when the Action should self-render instead:
 *  no covering App install (403/404), no open PR at this commit (the App
 *  can't comment, but the Action can, it resolves merged PRs too), or the
 *  trigger endpoint erroring (5xx / network). A 429 means the daily render
 *  cap: same red check as the self-render path. */
async function tryAppHandoff(sha) {
  const [owner, name] = (REPO || "").split("/");
  if (!owner || !name) return { fallback: "no repository in context" };

  let res;
  try {
    res = await fetch(`${API}/v1/github/trigger/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        sha,
        url: URL_,
        reel: REEL,
        // Best-effort: a deploy webhook may already have rendered this commit.
        ...(FULL_SHA_RE.test(sha) ? { dedup: true } : {}),
        ...(TASK ? { task: TASK } : {}),
        ...(CREDENTIAL ? { credential: CREDENTIAL } : {}),
        ...(VERCEL_BYPASS ? { vercel_bypass: VERCEL_BYPASS } : {}),
        ...(LOGIN_HINTS.length ? { login_hints: LOGIN_HINTS } : {}),
      }),
    });
  } catch (e) {
    console.log(`Ducky: trigger unreachable (${e?.message ?? e}), falling back to rendering from the Action.`);
    return { fallback: "trigger unreachable" };
  }

  if (res.status === 202) {
    const out = await res.json().catch(() => null);
    // A 202 without a render id would poll nothing into a false green; treat
    // a malformed acceptance as a hard error instead.
    if (!out || typeof out.render_id !== "string" || !out.render_id) {
      fail(`trigger accepted the handoff but answered an unexpected body: ${JSON.stringify(out)?.slice(0, 200) ?? "not JSON"}`);
    }
    console.log(`Ducky: handed off to the Ducky GitHub App, render ${out.render_id}${out.pr_number ? ` (PR #${out.pr_number})` : ""}. The App posts the comment when it finishes.`);
    const { render: final, observed } = await pollRender(out.render_id);
    if (!final) {
      if (!observed) {
        // Every poll failed: we never saw the render at all, so "the App will
        // post" is an assumption, not an observation. Go red.
        fail(`handed off render ${out.render_id} but could not read its status even once`);
      }
      // The App posts whenever the render finishes, with or without us; an
      // expired poll is not a failure, so don't turn the check red for it.
      console.log(`Ducky: render ${out.render_id} still running when the poll budget expired. Final result lands on the PR and the dashboard.`);
      process.exit(0);
    }
    if (!DONE.includes(final.status) && final.status !== "skipped") {
      fail(`render ${final.status} (render ${out.render_id})`);
    }
    console.log(`Ducky: render ${out.render_id} finished (${final.status}), comment posted by the Ducky GitHub App.`);
    process.exit(0);
  }

  if (res.status === 200) {
    const out = await res.json().catch(() => null);
    // Only a well-formed skip is App-owned; anything else malformed on a 200
    // must not silently become a green check with no render anywhere.
    if (!out || out.status !== "skipped" || typeof out.reason !== "string") {
      fail(`unexpected trigger response (200): ${JSON.stringify(out)?.slice(0, 200) ?? "not JSON"}`);
    }
    // When the server sends a machine-readable code it decides alone; the
    // exact reason-string match only covers servers that predate the field.
    const noOpenPr = out.code != null ? out.code === "no_open_pr" : out.reason === NO_OPEN_PR_REASON;
    if (noOpenPr) {
      console.log("Ducky: the App found no open PR at this commit, rendering from the Action (covers merged PRs).");
      return { fallback: "no open PR" };
    }
    // Everything else skipped is App-owned: a not-demoable change (the App
    // posts the skip note) or a commit already rendered (dedup).
    console.log(`Ducky: skipped by the Ducky GitHub App: ${out.reason}${out.render_id ? ` (${out.render_id})` : ""}.`);
    process.exit(0);
  }

  if (res.status === 401) {
    fail(`Ducky API key rejected (401): ${(await res.text()).slice(0, 200)}`);
  }
  if (res.status === 403 || res.status === 404) {
    console.log("Ducky: this repo isn't covered by a Ducky GitHub App install for this API key, rendering from the Action.");
    return { fallback: `no covering install (${res.status})` };
  }
  if (res.status === 429) {
    fail(`render rejected (429): ${(await res.text()).slice(0, 200)}`);
  }
  if (res.status >= 500) {
    console.log(`Ducky: trigger failed (${res.status}), falling back to rendering from the Action.`);
    return { fallback: `trigger ${res.status}` };
  }
  // 400s other than the handled set are caller bugs; surface them loudly
  // rather than masking them behind a second, differently-shaped failure.
  fail(`handoff rejected (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

// No `task` input → derive one from the PR. Ducky's server decides whether the
// change is user-visible; if not, skip cleanly (exit 0, no render, no comment).
async function deriveTask(event) {
  let title = event.pull_request?.title;
  let body = event.pull_request?.body || undefined;
  if (!title) {
    // push event: fetch the resolved PR for its title/body.
    const res = await gh(`/repos/${REPO}/pulls/${PR}`);
    if (res.ok) {
      const pr = await res.json();
      title = pr.title;
      body = pr.body || undefined;
    }
  }
  if (!title) fail("no task input and no PR title found. Set `task`, or run on a pull_request event.");

  const diffRes = await gh(`/repos/${REPO}/pulls/${PR}`, "application/vnd.github.diff");
  if (!diffRes.ok) fail(`fetching the PR diff failed (${diffRes.status}). Does the workflow grant 'contents: read'?`);
  const diff = (await diffRes.text()).slice(0, 6_000);

  console.log("Ducky: no task set, deriving one from the PR");
  const res = await fetch(`${API}/v1/derive`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ title: title.slice(0, 300), body: body?.slice(0, 10_000), diff, url: URL_ }),
  });
  if (!res.ok) fail(`task derivation failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const verdict = await res.json();
  if (!verdict.demoable) {
    console.log(`Ducky: nothing user-visible to demo in this PR, skipping. (${verdict.reason ?? "no reason given"})`);
    process.exit(0);
  }
  console.log(`Ducky: derived task: ${verdict.task}`);
  return verdict.task;
}

async function main() {
  if (!KEY) fail("missing required input: api-key");

  const event = readEvent();
  const sha = headSha(event);
  if (!sha) fail("no commit in context. Run this action on a pull_request or push event.");
  if (!URL_) URL_ = await waitForDeployment(sha);

  // Offer the render to the Ducky GitHub App first. Exits when the App owns
  // the outcome; returns when the Action should render it itself.
  const { fallback } = await tryAppHandoff(sha);
  console.log(`Ducky: self-rendering (${fallback}).`);

  if (!PR) {
    PR = await resolvePr(sha);
    console.log(`Ducky: resolved PR #${PR} from ${sha.slice(0, 7)}`);
  }
  if (!TASK) TASK = await deriveTask(event);

  // 1) submit the render
  console.log(`Ducky: rendering ${URL_}`);
  const subRes = await fetch(`${API}/v1/renders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      url: URL_, task: TASK, reel: REEL, source: "github_pr",
      ...(CREDENTIAL ? { credential: CREDENTIAL } : {}),
      ...(VERCEL_BYPASS ? { vercel_bypass: VERCEL_BYPASS } : {}),
      ...(LOGIN_HINTS.length ? { login_hints: LOGIN_HINTS } : {}),
    }),
  });
  if (!subRes.ok) fail(`render submit failed (${subRes.status}): ${(await subRes.text()).slice(0, 300)}`);
  const sub = await subRes.json();
  console.log(`Ducky: render ${sub.id} queued`);

  // 2) poll to a terminal state
  const { render: final } = await pollRender(sub.id);
  if (!final) fail("render timed out (>10 min)");
  if (!DONE.includes(final.status)) fail(`render ${final.status}`);
  const video = final.reel_url || final.demo_url;
  if (!video) fail("render finished but produced no video");

  // 3) post the PR comment via the GitHub REST API (JSON body, no shell escaping)
  // With a GIF preview: the animated image IS the link (external images embed
  // inline on GitHub; external videos never do). Without one: plain link.
  const watch = final.preview_url
    ? `[![Watch the demo](${final.preview_url})](${video})\n\n▶️ **[Watch the full demo](${video})**`
    : `▶️ **[Watch the demo](${video})**`;
  const body = [
    "🦆 **Ducky: demo of this change**",
    "",
    `**Task:** ${TASK}`,
    "",
    watch,
    "",
    '<sub>Auto-generated by <a href="https://tryducky.dev">Ducky</a>.</sub>',
  ].join("\n");
  const cRes = await fetch(`https://api.github.com/repos/${REPO}/issues/${PR}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "content-type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ body }),
  });
  if (!cRes.ok) {
    fail(`posting the PR comment failed (${cRes.status}): ${(await cRes.text()).slice(0, 200)}. Does the workflow grant 'permissions: pull-requests: write'?`);
  }
  console.log(`Ducky: posted demo to PR #${PR}`);
}

main().catch((e) => fail(e?.message ?? String(e)));
