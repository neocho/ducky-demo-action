// Runs the real index.mjs as a subprocess with the fetch stub preloaded,
// then hands back the exit code, combined output, and every request made.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
export const API = "https://ducky.test";

export function runAction({ spec = [], env = {}, event = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ducky-action-test-"));
  const specPath = join(dir, "spec.json");
  const logPath = join(dir, "requests.jsonl");
  const eventPath = join(dir, "event.json");
  writeFileSync(specPath, JSON.stringify(spec));
  writeFileSync(eventPath, JSON.stringify(event));

  const res = spawnSync(
    process.execPath,
    ["--import", join(root, "test", "fetch-stub.mjs"), join(root, "index.mjs")],
    {
      env: {
        PATH: process.env.PATH,
        STUB_SPEC: specPath,
        STUB_LOG: logPath,
        DUCKY_API_KEY: "test-key",
        DUCKY_API_BASE: API,
        GH_TOKEN: "gh-test-token",
        GH_REPO: "octo-org/widget-app",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_SHA: SHA,
        // 1ms polls; a 30s default render budget keeps happy-path tests off
        // the expiry branch even on a stalled runner. Expiry-shaped cases set
        // RENDER_TIMEOUT to "0"/"1" explicitly.
        POLL_INTERVAL_MS: "1",
        DEPLOY_POLL_MS: "1",
        RENDER_TIMEOUT: "30",
        RENDER_URL: "https://preview.example.test",
        ...env,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  const requests = existsSync(logPath)
    ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { code: res.status, out: (res.stdout || "") + (res.stderr || ""), requests };
}

/** The parsed JSON body of the first request whose URL contains `urlPart`. */
export function bodyOf(requests, urlPart, method = "POST") {
  const req = requests.find((r) => r.method === method && r.url.includes(urlPart));
  return req ? JSON.parse(req.body) : undefined;
}

export const hits = (requests, urlPart) => requests.filter((r) => r.url.includes(urlPart));
