/**
 * Dual-module smoke test: loads the built package both as CommonJS and as ESM,
 * asserts identical export surfaces, and runs the core pipeline from each build.
 *
 * Run after `npm run build`: node scripts/dual-check.mjs
 */

import { createRequire } from "node:module";
import { strict as assert } from "node:assert";

const require = createRequire(import.meta.url);
const cjs = require("../dist/index.js");
const esm = await import("../dist/index.mjs");

const REQUIRED_EXPORTS = [
  "extractEntities",
  "buildAllDdl",
  "buildTableDdl",
  "buildAlterScript",
  "buildDeploymentScript",
  "buildIndexes",
  "buildInsertStatements",
  "buildSampleData",
  "diffEntityAgainstLive",
  "buildComponentSchema",
  "buildComponentPatch",
  "planComponentPatch",
  "buildGraph",
  "buildImpactIndex",
  "operationsForEntity",
  "buildReconciliation",
  "exportReconciliationJson",
  "exportReconciliationMarkdown",
  "buildMermaidErDiagram",
  "RECONCILIATION_SCHEMA_VERSION",
  "DIALECTS",
];

const cjsKeys = Object.keys(cjs).sort();
const esmKeys = Object.keys(esm).sort();
assert.equal(cjsKeys.length, esmKeys.length, "CJS and ESM export counts differ");
assert.deepEqual(cjsKeys, esmKeys, "CJS and ESM export surfaces differ");

for (const name of REQUIRED_EXPORTS) {
  assert.ok(name in cjs, `missing CJS export: ${name}`);
  assert.ok(name in esm, `missing ESM export: ${name}`);
}

const FUNCTION_EXPORTS = REQUIRED_EXPORTS.filter((name) => name !== "RECONCILIATION_SCHEMA_VERSION" && name !== "DIALECTS");
for (const name of FUNCTION_EXPORTS) {
  assert.equal(typeof cjs[name], "function", `CJS ${name} is not a function`);
  assert.equal(typeof esm[name], "function", `ESM ${name} is not a function`);
}

const doc = {
  openapi: "3.1.0",
  info: { title: "Dual", version: "1.0.0" },
  paths: {
    "/orders": {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Order" } },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Customer: {
        type: "object",
        properties: {
          id: { type: "integer", format: "int64" },
          name: { type: "string", maxLength: 100 },
        },
      },
      Order: {
        type: "object",
        properties: {
          id: { type: "integer", format: "int64" },
          customer: { $ref: "#/components/schemas/Customer" },
          total: { type: "number", format: "decimal" },
        },
        required: ["customer", "total"],
      },
    },
  },
};

for (const [label, mod] of [
  ["CJS", cjs],
  ["ESM", esm],
]) {
  const report = mod.buildReconciliation({ doc, dialectId: "mysql", now: () => new Date("2024-01-01T00:00:00Z") });
  assert.equal(report.summary.modeledTables, 2, `${label}: expected 2 modeled tables`);
  assert.equal(report.summary.relationships, 1, `${label}: expected 1 relationship`);
  assert.equal(report.summary.missing, 2, `${label}: expected 2 missing tables`);
  const json = mod.exportReconciliationJson(report);
  assert.doesNotThrow(() => JSON.parse(json), `${label}: JSON export is not parseable`);
  const md = mod.exportReconciliationMarkdown(report);
  assert.ok(md.includes("erDiagram"), `${label}: Markdown lacks Mermaid diagram`);
  const mermaid = mod.buildMermaidErDiagram(report);
  assert.ok(/t_customers\s+\|\|--o\{\s+t_orders/.test(mermaid), `${label}: unexpected Mermaid edge`);
}

console.log(`Dual-module check passed: ${cjsKeys.length} exports, CJS and ESM identical and functional.`);
