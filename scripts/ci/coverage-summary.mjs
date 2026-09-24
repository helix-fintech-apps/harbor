#!/usr/bin/env node
// Render a Vitest/Istanbul coverage-summary.json as a Markdown table for $GITHUB_STEP_SUMMARY.
//   node scripts/ci/coverage-summary.mjs coverage/coverage-summary.json >> "$GITHUB_STEP_SUMMARY"
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const file = process.argv[2] ?? "coverage/coverage-summary.json";
const summary = JSON.parse(readFileSync(file, "utf8"));
const metrics = ["lines", "statements", "functions", "branches"];
const pct = (m) => `${m.pct.toFixed(1)}%`;

const rows = Object.entries(summary)
  .filter(([key]) => key !== "total")
  .map(
    ([path, s]) =>
      `| \`${relative(process.cwd(), path)}\` | ${metrics.map((m) => pct(s[m])).join(" | ")} |`,
  )
  .sort();

console.log("### Unit test coverage (domain)\n");
console.log(`| File | ${metrics.join(" | ")} |`);
console.log(`| --- | ${metrics.map(() => "---:").join(" | ")} |`);
console.log(`| **Total** | ${metrics.map((m) => `**${pct(summary.total[m])}**`).join(" | ")} |`);
for (const row of rows) console.log(row);
