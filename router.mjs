// Pick a model for a subtask by difficulty, using the table bench.mjs produced.
import { readFileSync } from "node:fs";

const routing = JSON.parse(readFileSync(new URL("./routing.json", import.meta.url), "utf8"));

export function pickModel(difficulty /* "easy" | "medium" | "hard" */) {
  return routing[difficulty] ?? routing.hard;
}

// self-check: node router.mjs
if (process.argv[1]?.endsWith("router.mjs")) {
  for (const d of ["easy", "medium", "hard", "unknown"])
    console.log(d, "->", pickModel(d));
}
