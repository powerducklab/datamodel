/**
 * @powerduck/datamodel
 *
 * Browser-safe, dependency-free relational modeling core for OpenAPI.
 *
 * Forward engineering (OpenAPI -> relational model):
 *   - extractEntities: component schemas and inline request/response bodies
 *     become relational entities; object references become foreign keys.
 *   - buildAllDdl / buildTableDdl / buildAlterScript, buildIndexes,
 *     buildInsertStatements, buildDeploymentScript: deterministic, dialect-aware
 *     SQL for MySQL, SQL Server and Oracle (generated only, never executed).
 *   - buildSampleData: deterministic sample rows.
 *
 * Reverse engineering (live database -> OpenAPI):
 *   - buildComponentSchema / planComponentPatch and SQL type inference.
 *   - diffEntityAgainstLive: additive, superset-safe model-vs-live comparison.
 *
 * AI-ready reconciliation (the unified human + machine artifact):
 *   - buildGraph: merge modeled and live tables/foreign keys into one ER graph
 *     with matched / drift / missing / extra node states.
 *   - buildImpactIndex / operationsForEntity: table -> affected API operations.
 *   - buildReconciliation: versioned, self-contained reconciliation result.
 *   - exportReconciliationJson / exportReconciliationMarkdown /
 *     buildMermaidErDiagram: machine and human representations.
 *
 * @example
 * ```ts
 * import { buildReconciliation, exportReconciliationMarkdown } from "@powerduck/datamodel";
 *
 * const report = buildReconciliation({ doc: openApiDocument, dialectId: "mysql" });
 * console.log(report.summary); // { missing: 8, drift: 0, matched: 0, ... }
 * console.log(exportReconciliationMarkdown(report));
 * ```
 */

export * from "./types";
export * from "./naming";
export * from "./dialects";
export * from "./entities";
export * from "./ddl";
export * from "./indexes";
export * from "./inserts";
export * from "./deploy";
export * from "./sampleData";
export * from "./diff";
export * from "./component";
export * from "./graph";
export * from "./impact";
export * from "./reconciliation";
export * from "./exporters";
