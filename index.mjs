// Ducky Demo Action runtime.
//
// Reads inputs from env (mapped by action.yml), renders a demo via the Ducky
// API, and posts the video as a PR comment.
//   - No `url` input → waits for this commit's deployment (GitHub deployments
//     API — e.g. a Vercel/Netlify preview) and renders its environment_url,
//     so the demo always shows the PR's actual code.
//   - No `task` input → sends the PR's title/body/diff to Ducky, which derives
//     what to demo — or says nothing user-visible changed (clean skip).
//   - Works on pull_request AND push events (the PR is resolved from the
//     commit when it's not in the event context).
//
// Zero deps: node20 global fetch + the GitHub REST API. The PR comment is posted
// with a JSON body (NOT shell-interpolated) so backticks/newlines aren't mangled.

import { readFileSync } from "node:fs";

const env = process.env;
const fail = (msg) => { console.log(`::error::Ducky: ${msg}`); process.exit(1); };

const KEY = env.DUCKY_API_KEY;
let URL_ = env.RENDER_URL;
let TASK = env.RENDER_TASK;
const REEL = env.RENDER_REEL !== "false"; // default true
// T-082 app-login: labels of stored credentials (never the secrets) + the
// custom login-path hints — forwarded verbatim to the render.
const CREDENTIAL = env.RENDER_CREDENTIAL || undefined;
const VERCEL_BYPASS = env.RENDER_VERCEL_BYPASS || undefined;
const LOGIN_HINTS = (env.RENDER_LOGIN_HINTS || "")
  .split(",").map((h) => h.trim()).filter(Boolean);
const API = (env.DUCKY_API_BASE || "https://api.tryducky.dev").replace(/\/+$/, "");
let PR = env.PR_NUMBER;
const GH_TOKEN = env.GH_TOKEN;
const REPO = env.GH_REPO; // owner/repo
const WAIT_TIMEOUT_S = Math.max(30, parseInt(env.WAIT_TIMEOUT || "300", 10) || 300);

const POLL_INTERVAL_MS = 20_000;
const POLL_MAX = 30; // ~10 min cap
const DEPLOY_POLL_MS = 10_000;
const DONE = ["done", "succeeded", "completed"];
const TERMINAL = [...DONE, "failed", "error", "cancelled"];

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
 *  context; works for merged PRs too). */
async function resolvePr(sha) {
  const res = await gh(`/repos/${REPO}/commits/${sha}/pulls`);
  if (!res.ok) fail(`resolving the PR for ${sha.slice(0, 7)} failed (${res.status})`);
  const prs = await res.json();
  if (!prs.length) {
    // A direct-to-main push with no associated PR has nothing to demo. Only push
    // events reach here (pull_request events carry their own PR), so skip quietly
    // (neutral, exit 0) instead of erroring with a red ✗ on every such commit.
    if (env.GITHUB_EVENT_NAME === "push") {
      console.log(`Ducky: no pull request for ${sha.slice(0, 7)} — skipping (direct push, nothing to demo).`);
      process.exit(0);
    }
    fail("no pull request found for this commit — run on a PR event, or push a merged PR's commit.");
  }
  const open = prs.find((p) => p.state === "open");
  return String((open ?? prs[0]).number);
}

/** Wait for a successful deployment of `sha` and return its environment_url.
 *  Polls GitHub's deployments API — the universal record hosts like Vercel/
 *  Netlify write when a preview finishes building. */
async function waitForDeployment(sha) {
  console.log(`Ducky: no url set — waiting for a deployment of ${sha.slice(0, 7)} (timeout ${WAIT_TIMEOUT_S}s)`);
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
          console.log(`Ducky: deployment ready — ${url}`);
          return url;
        }
      }
    }
    await sleep(DEPLOY_POLL_MS);
  }
  fail(`no successful deployment for ${sha.slice(0, 7)} within ${WAIT_TIMEOUT_S}s — pass \`url\` explicitly, raise \`wait-timeout\`, or check the deploy.`);
}

// No `task` input → derive one from the PR. Ducky's server decides whether the
// change is user-visible — if not, skip cleanly (exit 0, no render, no comment).
async function deriveTask(event) {
  let title = event.pull_request?.title;
  let body = event.pull_request?.body || undefined;
  if (!title) {
    // push event — fetch the resolved PR for its title/body.
    const res = await gh(`/repos/${REPO}/pulls/${PR}`);
    if (res.ok) {
      const pr = await res.json();
      title = pr.title;
      body = pr.body || undefined;
    }
  }
  if (!title) fail("no task input and no PR title found — set `task`, or run on a pull_request event.");

  const diffRes = await gh(`/repos/${REPO}/pulls/${PR}`, "application/vnd.github.diff");
  if (!diffRes.ok) fail(`fetching the PR diff failed (${diffRes.status}) — does the workflow grant 'contents: read'?`);
  const diff = (await diffRes.text()).slice(0, 6_000);

  console.log("Ducky: no task set — deriving one from the PR");
  const res = await fetch(`${API}/v1/derive`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ title: title.slice(0, 300), body: body?.slice(0, 10_000), diff, url: URL_ }),
  });
  if (!res.ok) fail(`task derivation failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const verdict = await res.json();
  if (!verdict.demoable) {
    console.log(`Ducky: nothing user-visible to demo in this PR — skipping. (${verdict.reason ?? "no reason given"})`);
    process.exit(0);
  }
  console.log(`Ducky: derived task — ${verdict.task}`);
  return verdict.task;
}

async function main() {
  if (!KEY) fail("missing required input: api-key");

  const event = readEvent();
  const sha = headSha(event);
  if (!PR) {
    if (!sha) fail("no pull request and no commit in context — run this action on a pull_request or push event.");
    PR = await resolvePr(sha);
    console.log(`Ducky: resolved PR #${PR} from ${sha.slice(0, 7)}`);
  }
  if (!URL_) URL_ = await waitForDeployment(sha);
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
  let final = null;
  for (let i = 0; i < POLL_MAX && !final; i++) {
    await sleep(POLL_INTERVAL_MS);
    const r = await (await fetch(`${API}/v1/renders/${sub.id}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    })).json();
    console.log(`Ducky: ${r.status}`);
    if (TERMINAL.includes(r.status)) final = r;
  }
  if (!final) fail("render timed out (>10 min)");
  if (!DONE.includes(final.status)) fail(`render ${final.status}`);
  const video = final.reel_url || final.demo_url;
  if (!video) fail("render finished but produced no video");

  // 3) post the PR comment via the GitHub REST API (JSON body — no shell escaping)
  // With a GIF preview: the animated image IS the link (external images embed
  // inline on GitHub; external videos never do). Without one: plain link.
  const watch = final.preview_url
    ? `[![Watch the demo](${final.preview_url})](${video})\n\n▶️ **[Watch the full demo](${video})**`
    : `▶️ **[Watch the demo](${video})**`;
  const body = [
    "🦆 **Ducky — demo of this change**",
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
    fail(`posting the PR comment failed (${cRes.status}): ${(await cRes.text()).slice(0, 200)} — does the workflow grant 'permissions: pull-requests: write'?`);
  }
  console.log(`Ducky: posted demo to PR #${PR}`);
}

main().catch((e) => fail(e?.message ?? String(e)));
