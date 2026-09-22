/**
 * Runnable example for @powerduck/datamodel.
 *
 * It reads a normal OpenAPI document (demo/fixtures/ecommerce.json), builds the
 * forward-engineering reconciliation for a database that has not been created
 * yet, and writes both representations to demo/output/:
 *   - reconciliation.json  (canonical machine/AI contract)
 *   - reconciliation.md    (human brief with an embedded Mermaid erDiagram)
 *
 * Run from the package root with: npm run demo
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReconciliation,
  exportReconciliationJson,
  exportReconciliationMarkdown,
} from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "ecommerce.json");
const outputDir = join(here, "output");

function run(): void {
  const doc = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;

  // Forward engineering only: no live database is supplied, so every modeled
  // table is reported as "missing" and an ordered, additive migration plan is
  // produced.
  const report = buildReconciliation({
    doc,
    dialectId: "mysql",
    specDigest: "demo-ecommerce",
  });

  mkdirSync(outputDir, { recursive: true });
  const jsonPath = join(outputDir, "reconciliation.json");
  const markdownPath = join(outputDir, "reconciliation.md");
  writeFileSync(jsonPath, exportReconciliationJson(report), "utf8");
  writeFileSync(markdownPath, exportReconciliationMarkdown(report), "utf8");

  const { summary } = report;
  console.log("Data model reconciliation generated");
  console.log("------------------------------------");
  console.log(`Modeled tables:      ${summary.modeledTables}`);
  console.log(`Relationships:       ${summary.relationships}`);
  console.log(`New (missing):       ${summary.missing}`);
  console.log(`Drifting:            ${summary.drift}`);
  console.log(`Matched:             ${summary.matched}`);
  console.log(`Live-only (extra):   ${summary.extra}`);
  console.log(`Migration steps:     ${report.migrationPlan.length}`);
  console.log(`Open questions:      ${report.openQuestions.length}`);
  console.log("");
  console.log(`JSON:     ${jsonPath}`);
  console.log(`Markdown: ${markdownPath}`);
}

run();
