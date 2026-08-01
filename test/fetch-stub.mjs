// Test-only fetch stub, preloaded with `node --import` so index.mjs runs
// unmodified against scripted HTTP responses and zero real network.
//
// STUB_SPEC: path to a JSON array of rules, matched in order:
//   { url: "substring", method?: "POST", status?: 200, json?: {...},
//     text?: "...", times?: 1, network_error?: "message" }
// A rule with `times` is consumed that many times, then skipped, so one URL
// can answer differently across sequential calls (poll: running, then done).
// Every request is appended to STUB_LOG as a JSON line for assertions.
// An unmatched request answers 599 so a spec gap fails the run loudly.

import { readFileSync, appendFileSync } from "node:fs";

const spec = JSON.parse(readFileSync(process.env.STUB_SPEC, "utf8"));
const logPath = process.env.STUB_LOG;
const used = new Map();

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method || "GET").toUpperCase();
  appendFileSync(logPath, JSON.stringify({ method, url: u, body: init.body ?? null }) + "\n");
  for (let i = 0; i < spec.length; i++) {
    const rule = spec[i];
    if (rule.method && rule.method.toUpperCase() !== method) continue;
    if (!u.includes(rule.url)) continue;
    const n = used.get(i) ?? 0;
    if (rule.times !== undefined && n >= rule.times) continue;
    used.set(i, n + 1);
    if (rule.network_error) throw new Error(rule.network_error);
    const body = rule.json !== undefined ? JSON.stringify(rule.json) : (rule.text ?? "");
    return new Response(body, { status: rule.status ?? 200, headers: rule.headers });
  }
  return new Response(`unmatched request: ${method} ${u}`, { status: 599 });
};
