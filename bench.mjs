#!/usr/bin/env node
// Benchmark models on Fireworks AI (AMD CloudCredits) to build a difficulty->model routing table.
//
// Usage:  FIREWORKS_API_KEY=... node bench.mjs        (or put the key in .env)
// Output: results.json (raw runs), routing.json (tier -> model), table on stdout.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATEWAY = "https://api.fireworks.ai/inference/v1";

// The five candidate models (matched by suffix against the Fireworks catalog,
// e.g. accounts/fireworks/models/minimax-m3).
const WANTED = [
  "minimax-m3",
  "kimi-k2p7-code",
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
  "gemma-4-31b-it-nvfp4",
];

// Fireworks' models endpoint doesn't expose pricing — fill in $/1M tokens from
// https://fireworks.ai/pricing. Unpriced models rank by latency in routing.
const PRICES = {
  // "minimax-m3": { in: 0.0, out: 0.0 },
};

// ---------- tasks ----------
// grade kinds: "number" (last number in reply), "contains" (substring, case-insensitive),
// "code" (first ```block``` is concatenated with `tests` and run under node).
const TASKS = [
  // easy
  { id: "e1", tier: "easy", grade: "number", answer: 391,
    prompt: "What is 17 * 23? Reply with just the number." },
  { id: "e2", tier: "easy", grade: "contains", answer: "krahmcneb",
    prompt: "Reverse the string 'benchmark'. Reply with just the reversed string." },
  { id: "e3", tier: "easy", grade: "contains", answer: "quarterly@acme.io",
    prompt: "Extract the email address from this text and reply with only the email: 'Please send the Q3 numbers to quarterly@acme.io before Friday, cc the usual folks.'" },
  // medium
  { id: "m1", tier: "medium", grade: "number", answer: 1242,
    prompt: "A server handles 1200 requests/sec. Traffic grows 15%, then drops 10% from that peak. How many requests/sec now? Reply with just the number." },
  { id: "m2", tier: "medium", grade: "code",
    prompt: "Write a JavaScript function `chunk(arr, n)` that splits an array into consecutive chunks of size n (last chunk may be smaller). Reply with only one JavaScript code block defining the function at top level.",
    tests: `import assert from "node:assert";
assert.deepStrictEqual(chunk([1,2,3,4,5], 2), [[1,2],[3,4],[5]]);
assert.deepStrictEqual(chunk([], 3), []);
assert.deepStrictEqual(chunk([1,2,3], 3), [[1,2,3]]);` },
  { id: "m3", tier: "medium", grade: "code",
    prompt: "Write a JavaScript function `dedupe(words)` that removes duplicate strings case-insensitively, keeping the first occurrence's original casing and order. Reply with only one JavaScript code block defining the function at top level.",
    tests: `import assert from "node:assert";
assert.deepStrictEqual(dedupe(["Apple","apple","Banana","APPLE","banana","cherry"]), ["Apple","Banana","cherry"]);
assert.deepStrictEqual(dedupe([]), []);` },
  // hard
  { id: "h1", tier: "hard", grade: "number", answer: 211,
    prompt: "How many strings of length 5 over the alphabet {a, b, c} contain at least one 'a'? Reply with just the number." },
  { id: "h2", tier: "hard", grade: "code",
    prompt: "Write a JavaScript class `LRUCache` with constructor(capacity), get(key) returning the value or -1, and put(key, value). Both operations must refresh recency; put evicts the least-recently-used entry when over capacity. Reply with only one JavaScript code block defining the class at top level.",
    tests: `import assert from "node:assert";
const c = new LRUCache(2);
c.put(1, 1); c.put(2, 2);
assert.strictEqual(c.get(1), 1);
c.put(3, 3); // evicts 2 (get(1) refreshed 1)
assert.strictEqual(c.get(2), -1);
c.put(4, 4); // evicts 1
assert.strictEqual(c.get(1), -1);
assert.strictEqual(c.get(3), 3);
assert.strictEqual(c.get(4), 4);` },
  { id: "h3", tier: "hard", grade: "code",
    prompt: "Write a JavaScript function `evalExpr(s)` that evaluates an arithmetic expression string with + - * /, parentheses, and standard precedence, returning a number. Do not use eval or Function. Reply with only one JavaScript code block defining the function at top level.",
    tests: `import assert from "node:assert";
assert.strictEqual(evalExpr("2*(3+4)-5"), 9);
assert.strictEqual(evalExpr("10/4"), 2.5);
assert.strictEqual(evalExpr("1+2*3"), 7);
assert.strictEqual(evalExpr("(1+2)*(3+4)"), 21);` },
];

// ---------- plumbing ----------
function loadKey() {
  if (process.env.FIREWORKS_API_KEY) return process.env.FIREWORKS_API_KEY;
  try {
    const m = readFileSync(".env", "utf8").match(/^FIREWORKS_API_KEY=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch {}
  console.error("Set FIREWORKS_API_KEY (env or .env file).");
  process.exit(1);
}
const KEY = loadKey();
const headers = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

async function resolveModels() {
  const res = await fetch(`${GATEWAY}/models`, { headers });
  if (!res.ok) throw new Error(`models list failed: ${res.status} ${await res.text()}`);
  const { data } = await res.json();
  return WANTED.map((want) => {
    const hit = data.find((m) => m.id === want || m.id.endsWith(`/${want}`));
    if (!hit) {
      console.error(`⚠ model not found in Fireworks catalog: ${want}`);
      return null;
    }
    // prefer catalog pricing if Fireworks ever returns it, else the PRICES table
    const p = hit.pricing ?? (PRICES[want] &&
      { input: PRICES[want].in / 1e6, output: PRICES[want].out / 1e6 });
    return { want, id: hit.id, pricing: p ?? null };
  }).filter(Boolean);
}

async function ask(modelId, prompt) {
  const t0 = performance.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${GATEWAY}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: modelId, max_tokens: 8192, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const j = await res.json();
      return {
        text: j.choices?.[0]?.message?.content ?? "",
        usage: j.usage ?? {},
        ms: Math.round(performance.now() - t0),
      };
    } catch (e) {
      if (attempt === 1) return { error: String(e), ms: Math.round(performance.now() - t0) };
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function extractCode(text) {
  const m = text.match(/```(?:\w+)?\s*\n([\s\S]*?)```/);
  return m ? m[1] : text;
}

const TMP = mkdtempSync(join(tmpdir(), "bench-"));
let tmpN = 0;
function gradeCode(text, tests) {
  const file = join(TMP, `t${tmpN++}.mjs`);
  writeFileSync(file, extractCode(text) + "\n" + tests);
  const r = spawnSync("node", [file], { timeout: 10_000, encoding: "utf8" });
  return r.status === 0;
}

function grade(task, text) {
  if (task.grade === "contains") return text.toLowerCase().includes(task.answer.toLowerCase());
  if (task.grade === "number") {
    const nums = text.replace(/,(?=\d{3})/g, "").match(/-?\d+(\.\d+)?/g);
    return nums ? Number(nums[nums.length - 1]) === task.answer : false;
  }
  return gradeCode(text, task.tests);
}

function cost(pricing, usage) {
  if (!pricing) return null;
  return (usage.prompt_tokens ?? 0) * Number(pricing.input ?? 0) +
         (usage.completion_tokens ?? 0) * Number(pricing.output ?? 0);
}

// small concurrency pool — be gentle on the gateway
async function pool(jobs, width = 4) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (i < jobs.length) out.push(await jobs[i++]());
  }));
  return out;
}

// ---------- run ----------
const models = await resolveModels();
if (!models.length) process.exit(1);
console.log(`Benchmarking ${models.length} models × ${TASKS.length} tasks…\n`);

const runs = await pool(models.flatMap((m) =>
  TASKS.map((task) => async () => {
    const r = await ask(m.id, task.prompt);
    const pass = r.error ? false : grade(task, r.text);
    process.stdout.write(`${pass ? "✓" : "✗"} ${m.want} ${task.id}${r.error ? " (error)" : ""}\n`);
    return { model: m.want, modelId: m.id, task: task.id, tier: task.tier, pass,
             ms: r.ms, usage: r.usage, cost: r.usage ? cost(m.pricing, r.usage) : null,
             error: r.error ?? null };
  })
));

writeFileSync("results.json", JSON.stringify(runs, null, 2));

// ---------- summarize + routing ----------
const tiers = ["easy", "medium", "hard"];
const summary = models.map((m) => {
  const mine = runs.filter((r) => r.model === m.want);
  const byTier = Object.fromEntries(tiers.map((t) => {
    const rs = mine.filter((r) => r.tier === t);
    return [t, rs.filter((r) => r.pass).length / rs.length];
  }));
  const priced = mine.some((r) => r.cost != null);
  const totalCost = priced ? mine.reduce((s, r) => s + (r.cost ?? 0), 0) : null;
  const avgMs = Math.round(mine.reduce((s, r) => s + r.ms, 0) / mine.length);
  return { model: m.want, ...byTier, avgMs, totalCost };
});

const pct = (x) => `${Math.round(x * 100)}%`;
console.log("\nmodel                  easy   med    hard   avg ms   cost ($)");
for (const s of summary)
  console.log(`${s.model.padEnd(22)} ${pct(s.easy).padEnd(6)} ${pct(s.medium).padEnd(6)} ${pct(s.hard).padEnd(6)} ${String(s.avgMs).padEnd(8)} ${s.totalCost?.toFixed(4) ?? "n/a"}`);

// routing: per tier, cheapest (then fastest) model passing >=2/3 of that tier; else highest scorer
const routing = {};
for (const t of tiers) {
  const ok = summary.filter((s) => s[t] >= 2 / 3)
    .sort((a, b) => (a.totalCost ?? Infinity) - (b.totalCost ?? Infinity) || a.avgMs - b.avgMs);
  routing[t] = (ok[0] ?? [...summary].sort((a, b) => b[t] - a[t])[0]).model;
}
writeFileSync("routing.json", JSON.stringify(routing, null, 2));
console.log("\nrouting.json:", JSON.stringify(routing));
