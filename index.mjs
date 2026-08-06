// Ducky Demo Action runtime.
//
// Reads inputs from env (mapped by action.yml), renders a demo via the Ducky
// API, and makes sure the demo reaches the PR.
//   - ONE intake call per run: POST /v1/github/trigger/{owner}/{name}, always
//     carrying the PR's title/body/diff. The server resolves the repo and
//     DECLARES who owns the output in `mode`; the Action never infers that
//     from an error, so a hiccup can no longer look like "no App here".
//   - `mode: "app"`: the Ducky GitHub App renders and posts the comment
//     itself, with its full verification detail. This run keeps only the CI
//     signal: it polls the render and the check goes red on a failure within
//     render-timeout.
//   - `mode: "action"`: the render belongs to this run. Poll it, ask the
//     server for the composed comment, and post it verbatim, so it reads
//     exactly like the App's: verified demos, held notes, failure notes.
//   - A 200 skip is terminal whatever its reason (nothing was rendered and
//     nothing will be). Everything else, 400 / 401 / 429 / 5xx / network / a
//     mode this release doesn't know, is a red check. No path renders twice.
//   - No `url` input → waits for this commit's deployment (GitHub deployments
//     API) and renders its environment_url, so the demo always shows the PR's
//     actual code.
//   - Works on pull_request AND push events (the PR is resolved from the
//     commit when it's not in the event context). Open PRs only.

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
// Render poll budget, wall-clock. 0 is legal (poll once, then leave the
// render to finish server-side); the default matches the old ~10 min cap.
const parsedRenderTimeout = parseInt(env.RENDER_TIMEOUT || "", 10);
const RENDER_TIMEOUT_S = Number.isFinite(parsedRenderTimeout) ? Math.max(0, parsedRenderTimeout) : 600;

// Overridable so the test harness doesn't sit through real poll sleeps.
// Clamped to >=1ms so a bad value can never become a zero-delay hot loop.
const POLL_INTERVAL_MS = Math.max(1, parseInt(env.POLL_INTERVAL_MS || "", 10) || 20_000);
const DEPLOY_POLL_MS = Math.max(1, parseInt(env.DEPLOY_POLL_MS || "", 10) || 10_000);
// test-harness override like the two above; production always derives from WAIT_TIMEOUT
const WAIT_TIMEOUT_MS = parseInt(env.WAIT_TIMEOUT_MS || "", 10) || WAIT_TIMEOUT_S * 1000;
const DONE = ["done", "succeeded", "completed"];
const TERMINAL = [...DONE, "failed", "error", "cancelled", "skipped"];

// The commit dedup on the intake call compares full shas server-side, so an
// abbreviated sha would dedup nothing; only send the flag when it can work.
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
// Who owns the output of an accepted render. The server says which; a mode
// this release doesn't know is a version mismatch, never a guess.
const MODES = ["app", "action"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GitHub REST call with the workflow token. Returns the Response. A hung
 *  connection aborts at 30s rather than eating the whole job. */
const gh = (path, accept = "application/vnd.github+json") =>
  fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(30_000),
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

/** On the plain pull_request event, a PR from a fork has neither the api-key
 *  secret nor write permission, by design, so running means failing; skip
 *  quietly instead of going red on every outside contribution. Scoped to that
 *  event: pull_request_target DOES hand fork PRs the secrets, so it never
 *  skips. A deleted fork (head.repo null) still counts as a fork. The base
 *  name comes from the event when present (GH_REPO otherwise), compared
 *  case-insensitively the way GitHub treats repo names. */
function isForkPr(event) {
  if (env.GITHUB_EVENT_NAME !== "pull_request" || !event.pull_request) return false;
  const base = String(event.pull_request.base?.repo?.full_name ?? REPO ?? "").toLowerCase();
  if (!base) return false;
  const head = String(event.pull_request.head?.repo?.full_name ?? "").toLowerCase();
  return head !== base;
}

/** Post a comment on the PR with the workflow token. Fails loudly by default
 *  (the demo comment IS the deliverable); `bestEffort` swallows the error for
 *  comments that are courtesy notes, not deliverables. */
async function postComment(bodyText, { bestEffort = false } = {}) {
  const cRes = await fetch(`https://api.github.com/repos/${REPO}/issues/${PR}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "content-type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ body: bodyText }),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e?.message ?? e) }));
  if (!cRes.ok && !bestEffort) {
    fail(`posting the PR comment failed (${cRes.status}): ${(await cRes.text()).slice(0, 200)}. Does the workflow grant 'permissions: pull-requests: write'?`);
  }
  return cRes.ok;
}

/** Resolve the PR to demo from the commit (push events have no PR in
 *  context). OPEN PRs only: a demo belongs on a pull request while it is being
 *  reviewed, so a commit whose PRs have all merged or closed has nothing to
 *  show. Nothing open anywhere is a quiet skip (exit 0), never a red x. */
async function resolvePr(sha) {
  const res = await gh(`/repos/${REPO}/commits/${sha}/pulls`);
  if (!res.ok) fail(`resolving the PR for ${sha.slice(0, 7)} failed (${res.status})`);
  const prs = await res.json().catch(() => null);
  if (!Array.isArray(prs)) fail(`resolving the PR for ${sha.slice(0, 7)} answered an unexpected body`);
  const open = prs.find((p) => p.state === "open");
  if (open) return String(open.number);
  if (!prs.length) {
    console.log(env.GITHUB_EVENT_NAME === "push"
      ? `Ducky: no pull request for ${sha.slice(0, 7)}, skipping (direct push, nothing to demo).`
      : `Ducky: no pull request has ${sha.slice(0, 7)}, skipping (Ducky demos open pull requests).`);
  } else {
    console.log(`Ducky: no OPEN pull request has ${sha.slice(0, 7)}, skipping (Ducky demos open pull requests).`);
  }
  process.exit(0);
}

/** One selection pass over the deployments recorded for `sha`. The rule:
 *  sort deployments newest-first ourselves (GitHub documents no order), read
 *  each deployment's CURRENT state from its newest status, and prefer the
 *  newest deployment currently succeeded with a non-empty environment_url;
 *  failing that, the newest whose history has a success with a URL (a preview
 *  a later deploy retired, its URL still live). NEVER target_url: providers
 *  put the build-log page there (only Vercel mirrors the site URL into it),
 *  and a demo of a CI log page is worse than waiting. Deploys that never
 *  advertise environment_url (a hand-rolled deploy job, a package release)
 *  are treated as no deployment at all.
 *
 *  Cost discipline: GITHUB_TOKEN's REST budget is shared by every workflow in
 *  the repo, and this runs once per poll round, so the scan is capped at the
 *  20 listed / 10 newest deployments and bails at the wait deadline. API
 *  errors log their status (an exhausted budget must not read as "your host
 *  never deployed") and transient or malformed answers are a skipped round,
 *  never a crash. */
const newestFirst = (a, b) =>
  String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) || ((b.id ?? 0) - (a.id ?? 0));

async function selectDeploymentUrl(sha, deadline, seen = {}) {
  let raw;
  try {
    const dRes = await gh(`/repos/${REPO}/deployments?sha=${sha}&per_page=20`);
    if (!dRes.ok) {
      console.log(`Ducky: deployments API answered ${dRes.status}, retrying next round`);
      return null;
    }
    raw = await dRes.json();
  } catch { return null; }
  if (!Array.isArray(raw)) return null;
  const deps = raw.sort(newestFirst).slice(0, 10);
  let retired = null;
  for (const d of deps) {
    if (Date.now() >= deadline) break;
    let statuses;
    try {
      const sRes = await gh(`/repos/${REPO}/deployments/${d.id}/statuses?per_page=20`);
      if (!sRes.ok) {
        console.log(`Ducky: deployment statuses API answered ${sRes.status}, retrying next round`);
        continue;
      }
      statuses = await sRes.json();
    } catch { continue; }
    if (!Array.isArray(statuses)) continue;
    statuses.sort(newestFirst);
    const current = statuses[0];
    if (current?.state === "success" && current.environment_url) return current.environment_url;
    // A currently-failed deploy is a different diagnosis than "never deployed":
    // remember it so the timeout message can say what actually happened.
    if (current?.state === "failure" || current?.state === "error") seen.failed = true;
    if (!retired) {
      retired = statuses.find((s) => s.state === "success" && s.environment_url)?.environment_url ?? null;
    }
  }
  return retired;
}

/** Wait for a deployment of `sha` that advertises its URL, and return it. */
async function waitForDeployment(sha) {
  console.log(`Ducky: no url set, waiting for a deployment of ${sha.slice(0, 7)} (timeout ${WAIT_TIMEOUT_S}s)`);
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  const seen = {};
  for (;;) {
    const url = await selectDeploymentUrl(sha, deadline, seen);
    if (url) {
      console.log(`Ducky: deployment ready, ${url}`);
      return url;
    }
    if (Date.now() >= deadline) break;
    await sleep(DEPLOY_POLL_MS);
  }
  if (seen.failed) {
    fail(`the deploy of ${sha.slice(0, 7)} FAILED on your host, so there is no URL to record. Fix the deploy and re-run this workflow.`);
  }
  fail(`no deployment of ${sha.slice(0, 7)} advertised a URL within ${WAIT_TIMEOUT_S}s. Pass \`url\` explicitly, raise \`wait-timeout\`, or check the deploy. (Hosts that don't report deployments to GitHub, like Netlify or Cloudflare Pages, need an explicit \`url\`.)`);
}

/** Poll a render to a terminal state, on a wall-clock budget
 *  (`render-timeout`, default 600s). Polls first and sleeps after, so a fast
 *  render never waits out a full interval. Error responses and malformed
 *  bodies are transient (log and keep polling); `observed` reports whether a
 *  real render status was ever read, so an expiry where every poll failed is
 *  distinguishable from a render that is genuinely still running. */
async function pollRender(id) {
  const deadline = Date.now() + RENDER_TIMEOUT_S * 1000;
  let observed = false;
  for (;;) {
    let res = null;
    try {
      // Each request is bounded by the remaining budget (floor 5s), so a tiny
      // render-timeout can't hide a 30s in-flight hang.
      const perRequestMs = Math.min(30_000, Math.max(5_000, deadline - Date.now()));
      res = await fetch(`${API}/v1/renders/${id}`, {
        headers: { Authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(perRequestMs),
      });
    } catch { /* network blip or abort: transient */ }
    if (!res) {
      console.log("Ducky: poll error (network), retrying");
    } else if (!res.ok) {
      console.log(`Ducky: poll error (${res.status}), retrying`);
    } else {
      const r = await res.json().catch(() => null);
      if (!r || typeof r.status !== "string") {
        console.log("Ducky: poll returned an unexpected body, retrying");
      } else {
        observed = true;
        console.log(`Ducky: ${r.status}`);
        if (TERMINAL.includes(r.status)) return { render: r, observed };
      }
    }
    const left = deadline - Date.now();
    if (left <= 0) return { render: null, observed };
    await sleep(Math.min(POLL_INTERVAL_MS, left));
  }
}

/** The one PR intake call. It always carries the PR content, so a repo the
 *  Ducky GitHub App doesn't cover renders from the same request instead of a
 *  second one, and the server never has to answer an error to say "not mine".
 *  Returns {renderId, mode, prNumber} for an accepted render; a well-formed
 *  skip is terminal and exits 0 here; everything else is a red check. There is
 *  no fallback: an intake that fails renders nothing, and the workflow re-run
 *  button is the retry. */
async function triggerRender(sha, content) {
  const [owner, name] = (REPO || "").split("/");
  if (!owner || !name) fail("no repository in context. Run this action in a GitHub Actions workflow.");

  let res;
  try {
    // Deliberately NO abort signal on this one call: the server resolves,
    // derives, and enqueues before answering, so a client-side abort could
    // fire after the render exists, orphaning it red and inviting a duplicate
    // on re-run. A slow answer beats a duplicate.
    res = await fetch(`${API}/v1/github/trigger/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        sha,
        url: URL_,
        reel: REEL,
        title: content.title,
        ...(content.body ? { body: content.body } : {}),
        ...(content.diff ? { diff: content.diff } : {}),
        // Best-effort: a deploy webhook may already have rendered this commit.
        ...(FULL_SHA_RE.test(sha) ? { dedup: true } : {}),
        ...(TASK ? { task: TASK } : {}),
        ...(CREDENTIAL ? { credential: CREDENTIAL } : {}),
        ...(VERCEL_BYPASS ? { vercel_bypass: VERCEL_BYPASS } : {}),
        ...(LOGIN_HINTS.length ? { login_hints: LOGIN_HINTS } : {}),
      }),
    });
  } catch (e) {
    fail(`Ducky is unreachable (${e?.message ?? e}); nothing was rendered. Re-run this workflow to retry.`);
  }

  if (res.status === 202) {
    const out = await res.json().catch(() => null);
    // A 202 without a render id would poll nothing into a false green; treat
    // a malformed acceptance as a hard error instead.
    if (!out || typeof out.render_id !== "string" || !out.render_id) {
      fail(`the render was accepted but the answer was unexpected: ${JSON.stringify(out)?.slice(0, 200) ?? "not JSON"}`);
    }
    // Who posts the comment is the server's call. Inferring it is exactly the
    // habit this contract removes, so an absent or unknown mode is loud.
    if (!MODES.includes(out.mode)) {
      fail(`the render was accepted with an unknown mode (${JSON.stringify(out.mode) ?? "none"}), so who posts the comment is undefined. This action is out of step with the Ducky API; update to the latest release.`);
    }
    return { renderId: out.render_id, mode: out.mode, prNumber: out.pr_number };
  }

  if (res.status === 200) {
    const out = await res.json().catch(() => null);
    // Only a well-formed skip is a skip; anything else malformed on a 200 must
    // not silently become a green check with no render anywhere.
    if (!out || out.status !== "skipped" || typeof out.reason !== "string") {
      fail(`unexpected trigger response (200): ${JSON.stringify(out)?.slice(0, 200) ?? "not JSON"}`);
    }
    // Every skip is terminal: nothing was rendered, and nothing will be. The
    // reason is the whole story (not demoable, no open PR, already rendered).
    console.log(`Ducky: skipped: ${out.reason}${out.render_id ? ` (${out.render_id})` : ""}.`);
    process.exit(0);
  }

  if (res.status === 401) {
    fail(`Ducky API key rejected (401): ${(await res.text()).slice(0, 200)}`);
  }
  if (res.status === 429) {
    fail(`render rejected (429): ${(await res.text()).slice(0, 200)}. Re-run this workflow once the cap resets.`);
  }
  if (res.status >= 500) {
    fail(`Ducky answered ${res.status}; nothing was rendered. Re-run this workflow to retry: ${(await res.text()).slice(0, 200)}`);
  }
  // 400s and anything else unhandled are caller-side bugs; surface them
  // loudly rather than masking them behind a second, differently-shaped run.
  fail(`render request rejected (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

/** `mode: "app"`: the Ducky GitHub App owns this render and posts the comment
 *  with its full verification detail. This run posts nothing and keeps only
 *  the CI signal, so it polls and exits (0 on done/skipped, 1 on failed). */
async function awaitAppComment(renderId, prNumber) {
  console.log(`Ducky: the Ducky GitHub App owns render ${renderId}${prNumber ? ` (PR #${prNumber})` : ""}. It posts the comment when it finishes.`);
  const { render: final, observed } = await pollRender(renderId);
  if (!final) {
    if (!observed) {
      // Every poll failed: we never saw the render at all, so "the App will
      // post" is an assumption, not an observation. Go red.
      fail(`render ${renderId} was accepted but could not read its status even once`);
    }
    // The App posts whenever the render finishes, with or without us; an
    // expired poll is not a failure, so don't turn the check red for it.
    console.log(`Ducky: render ${renderId} still running when the poll budget expired. Final result lands on the PR and the dashboard.`);
    process.exit(0);
  }
  if (!DONE.includes(final.status) && final.status !== "skipped") {
    fail(`render ${final.status} (render ${renderId})`);
  }
  console.log(`Ducky: render ${renderId} finished (${final.status}), comment posted by the Ducky GitHub App.`);
  process.exit(0);
}

/** `mode: "action"`: the render belongs to this run, so poll it and post the
 *  comment the server composed for the row: identical builders to the App
 *  path, so held renders get the held note (and no video link), failures get
 *  the failure note, and verified demos get the full body. */
async function renderAndComment(renderId) {
  console.log(`Ducky: render ${renderId} queued`);
  const { render: final, observed } = await pollRender(renderId);
  if (!final && !observed) {
    // Every poll failed: nothing about this render was ever read, so a polite
    // "still rendering" note would be an invention. Go red.
    fail(`render ${renderId} was submitted but its status could not be read even once`);
  }
  if (!final) {
    // The render finishes server-side with or without us. Leave a note whose
    // past-tense wording stays true whatever the outcome (no marker, no later
    // edit; a re-run of an expired job stacks a second note, accepted).
    const posted = await postComment(
      [
        "🦆 **Ducky**",
        "",
        `The demo was still rendering when this check finished (waited ${RENDER_TIMEOUT_S}s). Check the [Ducky dashboard](https://tryducky.dev) for the result.`,
        "",
        '<sub>Auto-generated by <a href="https://tryducky.dev">Ducky</a>.</sub>',
      ].join("\n"),
      { bestEffort: true },
    );
    console.log(posted
      ? `Ducky: render ${renderId} still running at render-timeout (${RENDER_TIMEOUT_S}s); left a note, check the dashboard for the result.`
      : `Ducky: render ${renderId} still running at render-timeout (${RENDER_TIMEOUT_S}s); could not post the note (does the workflow grant 'permissions: pull-requests: write'?). Check the dashboard for the result.`);
    process.exit(0);
  }
  const comment = await fetchComposedComment(renderId);
  if (!comment) {
    // The render is terminal but its comment can't be had; exit honestly by
    // render status rather than inventing a body client-side. A skipped
    // render is green everywhere else, so it is green here too.
    console.log(`Ducky: could not fetch the composed comment for ${renderId}; no comment posted. See the dashboard.`);
    if (!DONE.includes(final.status) && final.status !== "skipped") fail(`render ${final.status}`);
    process.exit(0);
  }
  if (comment.post && typeof comment.body === "string" && comment.body) {
    await postComment(comment.body);
    console.log(`Ducky: posted the ${comment.outcome} comment to PR #${PR}`);
  } else {
    console.log(`Ducky: ${comment.outcome}; nothing to post.`);
  }
  if (comment.outcome === "failed") fail(`render failed; details are on the PR and the dashboard`);
}

/** The PR content Ducky derives from, gathered on EVERY run, explicit-task
 *  runs included: derive also supplies the description and claims the PR
 *  comment shows, so an explicit task must never buy a claimless comment. A
 *  very large PR (GitHub withholds the diff with a 406) derives from title and
 *  description alone. */
async function gatherPrContent(event) {
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
  if (!title) fail(`could not read PR #${PR} for its title. Does the workflow grant 'contents: read'?`);

  const diffRes = await gh(`/repos/${REPO}/pulls/${PR}`, "application/vnd.github.diff");
  let diff;
  if (diffRes.ok) {
    diff = (await diffRes.text()).slice(0, 6_000);
  } else if (diffRes.status === 406) {
    console.log("Ducky: GitHub withheld the diff (very large PR); deriving from the title and description.");
  } else {
    fail(`fetching the PR diff failed (${diffRes.status}). Does the workflow grant 'contents: read'?`);
  }
  return { title: title.slice(0, 300), body: body?.slice(0, 10_000), diff };
}

/** The server-composed comment for a terminal render: {outcome, post, body}.
 *  The whole union is validated, and null answers every fetch or shape
 *  failure, so a malformed response can neither post garbage nor flip the
 *  exit code: the caller falls back to exiting honestly by render status. */
const COMMENT_OUTCOMES = ["ready", "held", "failed", "skipped", "pending"];
async function fetchComposedComment(id) {
  try {
    const res = await fetch(`${API}/v1/renders/${id}/comment`, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const out = await res.json().catch(() => null);
    if (!out || !COMMENT_OUTCOMES.includes(out.outcome)) return null;
    if (typeof out.post !== "boolean") return null;
    if (out.post && (typeof out.body !== "string" || !out.body)) return null;
    return out;
  } catch {
    return null;
  }
}

async function main() {
  const event = readEvent();
  if (isForkPr(event)) {
    console.log("Ducky: PR from a fork, skipping (fork runs have no secrets and no write permission by design; nothing rendered).");
    process.exit(0);
  }
  if (!KEY) fail("missing required input: api-key");

  const sha = headSha(event);
  if (!sha) fail("no commit in context. Run this action on a pull_request or push event.");

  // The PR and its content are gathered BEFORE the intake call on every event:
  // the one call always carries them, so a repo without the App renders from
  // this request instead of a second one. Resolving first also means a commit
  // with no open PR skips without sitting through a deployment wait.
  if (!PR) {
    PR = await resolvePr(sha);
    console.log(`Ducky: resolved PR #${PR} from ${sha.slice(0, 7)}`);
  }
  const content = await gatherPrContent(event);

  if (!URL_) URL_ = await waitForDeployment(sha);

  // One call. The server decides whether the App or this run owns the output.
  console.log(`Ducky: rendering ${URL_}`);
  const { renderId, mode, prNumber } = await triggerRender(sha, content);
  if (mode === "app") await awaitAppComment(renderId, prNumber);
  else await renderAndComment(renderId);
}

main().catch((e) => fail(e?.message ?? String(e)));
