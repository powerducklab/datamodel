import { DIALECTS } from "./dialects";
import { buildIndexes } from "./indexes";
import type {
  DialectId,
  LiveColumn,
  LiveForeignKey,
  LiveTable,
  ModelColumn,
  ModelEntity,
} from "./types";
import { extractEntities } from "./entities";
import {
  buildAlterScript,
  buildAllDdl,
  resolveTableName,
  topoOrderEntities,
  type TableNameOverrides,
} from "./ddl";
import type { DiffItem } from "./diff";
import {
  buildGraph,
  tableKey,
  type GraphNode,
  type GraphNodeStatus,
  type GraphRelationship,
  type RelationshipConfidence,
} from "./graph";
import { buildImpactIndex, operationsForEntity } from "./impact";

/**
 * The reconciliation artifact: a single, versioned, self-contained,
 * deterministically computed object that describes how an OpenAPI-derived
 * relational model aligns with an optional live database.
 *
 * It is designed to be consumed by both humans (rendered as an ER graph /
 * Markdown report) and AI coding agents (serialized to JSON). Facts are
 * separated into observed live state, modeled intent, proposed additive SQL
 * and explicit open questions, so a model never has to guess table shapes,
 * relationships, impact scope or migration order.
 *
 * The artifact is read-only evidence. Powerduck never executes DDL/DML.
 */

export const RECONCILIATION_SCHEMA_VERSION = "1.0.0";

export interface ReconciliationModeledColumn {
  jsonType: ModelColumn["jsonType"];
  format?: string;
  primaryKey: boolean;
  nullable: boolean;
  unique: boolean;
}

export interface ReconciliationLiveColumn {
  dataType?: string;
  nullable?: boolean;
  primaryKey?: boolean;
}

export interface ReconciliationColumnPair {
  /** Physical column name. */
  name: string;
  modeled?: ReconciliationModeledColumn;
  live?: ReconciliationLiveColumn;
}

export interface ReconciliationTable {
  table: string;
  logicalName?: string;
  entityId?: string;
  source?: ModelEntity["source"];
  /** Composite primary-key columns for associative/link tables. */
  compositePrimaryKey?: string[];
  status: GraphNodeStatus;
  confidence: RelationshipConfidence;
  modeled: boolean;
  live: boolean;
  columns: ReconciliationColumnPair[];
  /** Outgoing relationships where this table is the child (FK owner). */
  relationships: GraphRelationship[];
  diffs: DiffItem[];
  /** API operations affected when this table/schema changes. */
  impactedOperations: string[];
  proposedSql: {
    /** CREATE statements for a missing table. */
    createStatements: string[];
    /** Additive ALTER statements for a drifting table. */
    alterStatements: string[];
  };
}

export interface OrphanTable {
  table: string;
  columns: LiveColumn[];
}

export type MigrationStepKind = "create_table" | "alter_table" | "review_orphan_table";

export interface MigrationStep {
  /** 1-based execution order. */
  order: number;
  kind: MigrationStepKind;
  target: string;
  description: string;
  sql: string[];
  /** Orders of steps that must complete before this one. */
  blockedBy: number[];
  /** True when a human must review instead of blindly executing. */
  requiresReview: boolean;
}

export type OpenQuestionSeverity = "warning" | "info";

export interface OpenQuestion {
  code:
    | "no_live_database"
    | "cyclic_foreign_key_skipped"
    | "relationship_not_enforced"
    | "junction_table_inferred"
    | "table_not_in_model";
  severity: OpenQuestionSeverity;
  table?: string;
  message: string;
}

export interface ReconciliationSummary {
  entities: number;
  modeledTables: number;
  liveTables: number;
  relationships: number;
  enforcedRelationships: number;
  unenforcedRelationships: number;
  matched: number;
  drift: number;
  missing: number;
  extra: number;
  actionableItems: number;
  warningItems: number;
}

export interface ReconciliationSpecSource {
  title?: string;
  version?: string;
  digest?: string;
  operationCount: number;
}

export interface ReconciliationDatabaseSource {
  dialect: DialectId;
  connected: boolean;
  name?: string;
  host?: string;
  database?: string;
  tableCount: number;
}

export interface DataModelReconciliation {
  schemaVersion: string;
  generatedAt: string;
  dialect: DialectId;
  source: {
    spec?: ReconciliationSpecSource;
    database?: ReconciliationDatabaseSource;
  };
  summary: ReconciliationSummary;
  /** Modeled tables in deterministic entity order (missing/drift/matched). */
  tables: ReconciliationTable[];
  /** Live tables with no counterpart in the API model. */
  orphanTables: OrphanTable[];
  relationships: GraphRelationship[];
  migrationPlan: MigrationStep[];
  openQuestions: OpenQuestion[];
  safeguards: string[];
}

export interface BuildReconciliationOptions {
  /** Independently reviewed persistence model, when supplied. */
  entities?: ModelEntity[];
  doc: unknown;
  dialectId?: DialectId;
  liveTables?: LiveTable[];
  liveForeignKeys?: LiveForeignKey[];
  overrides?: TableNameOverrides;
  /** Optional content digest of the source document, echoed back verbatim. */
  specDigest?: string;
  /** Optional saved database profile metadata for the source block. */
  database?: { name?: string; host?: string; database?: string };
  /** Injectable clock so output is deterministic in tests. */
  now?: () => Date;
}

const SAFEGUARDS: string[] = [
  "Powerduck generates SQL but never executes DDL or DML against a database.",
  "The live database is treated as a superset: extra columns and tables are reported, never dropped.",
  "Proposed statements are additive (CREATE TABLE IF NOT EXISTS / ADD or MODIFY COLUMN); destructive changes are intentionally not generated.",
  "Review the migration and run it with an account you control.",
  "Relationships reported as unenforced or inferred must be confirmed before relying on them.",
];

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function modeledColumnView(column: ModelColumn): ReconciliationModeledColumn {
  return {
    jsonType: column.jsonType,
    ...(column.format ? { format: column.format } : {}),
    primaryKey: column.primaryKey,
    nullable: column.nullable,
    unique: column.unique,
  };
}

function liveColumnView(column: LiveColumn): ReconciliationLiveColumn {
  return {
    ...(column.dataType ? { dataType: column.dataType } : {}),
    nullable: column.nullable,
    primaryKey: column.isPrimaryKey,
  };
}

function buildColumnPairs(node: GraphNode): ReconciliationColumnPair[] {
  const pairs: ReconciliationColumnPair[] = [];
  const liveByColumn = new Map(
    node.liveColumns.map((column) => [column.name.toLowerCase(), column]),
  );
  const matchedLive = new Set<string>();

  for (const modeled of node.modeledColumns) {
    const live = liveByColumn.get(modeled.columnName.toLowerCase());
    if (live) matchedLive.add(live.name.toLowerCase());
    pairs.push({
      name: modeled.columnName,
      modeled: modeledColumnView(modeled),
      ...(live ? { live: liveColumnView(live) } : {}),
    });
  }

  for (const live of node.liveColumns) {
    if (matchedLive.has(live.name.toLowerCase())) continue;
    if (node.modeledColumns.some((c) => c.columnName.toLowerCase() === live.name.toLowerCase())) {
      continue;
    }
    pairs.push({ name: live.name, live: liveColumnView(live) });
  }

  return pairs;
}

/**
 * Build the full reconciliation artifact from a parsed OpenAPI document and,
 * optionally, read-only live database evidence.
 */
export function buildReconciliation(
  options: BuildReconciliationOptions,
): DataModelReconciliation {
  const dialectId: DialectId = options.dialectId ?? "mysql";
  const entities: ModelEntity[] = options.entities ?? extractEntities(options.doc);
  const hasLive = Array.isArray(options.liveTables);
  const liveTables = options.liveTables ?? [];
  const liveForeignKeys = options.liveForeignKeys ?? [];

  const graph = buildGraph(entities, {
    dialectId,
    ...(hasLive ? { liveTables, liveForeignKeys } : {}),
    overrides: options.overrides,
  });
  const impact = buildImpactIndex(options.doc);

  const nodeByEntityId = new Map<string, GraphNode>();
  const nodeByTableKey = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    nodeByTableKey.set(node.id, node);
    if (node.entityId) nodeByEntityId.set(node.entityId, node);
  }

  const findLiveTable = (physical: string): LiveTable | undefined =>
    liveTables.find((table) => {
      const qualified = table.schema ? `${table.schema}.${table.name}` : table.name;
      return tableKey(qualified) === tableKey(physical);
    });

  const tables: ReconciliationTable[] = entities.map((entity) => {
    const physical = resolveTableName(entity, options.overrides);
    const node = nodeByEntityId.get(entity.id);
    const status: GraphNodeStatus = node?.status ?? "missing";
    const relationships = graph.relationships.filter(
      (relationship) => tableKey(relationship.fromTable) === tableKey(physical),
    );

    let createStatements: string[] = [];
    let alterStatements: string[] = [];
    if (status === "missing") {
      createStatements = buildAlterScript(
        dialectId,
        entity,
        undefined,
        entities,
        options.overrides,
      );
    } else if (status === "drift") {
      alterStatements = buildAlterScript(
        dialectId,
        entity,
        findLiveTable(physical),
        entities,
        options.overrides,
      );
    }

    return {
      table: physical,
      logicalName: entity.name,
      entityId: entity.id,
      source: entity.source,
      ...(entity.compositePrimaryKey?.length
        ? { compositePrimaryKey: entity.compositePrimaryKey }
        : {}),
      status,
      confidence: entity.source === "junction" ? "medium" : "high",
      modeled: true,
      live: node?.live ?? false,
      columns: buildColumnPairs(node ?? {
        id: tableKey(physical),
        table: physical,
        status: "missing",
        modeled: true,
        live: false,
        modeledColumns: entity.columns,
        liveColumns: [],
        diffs: [],
      }),
      relationships,
      diffs: node?.diffs ?? [],
      impactedOperations: operationsForEntity(entity, impact),
      proposedSql: { createStatements, alterStatements },
    };
  });

  const orphanTables: OrphanTable[] = graph.nodes
    .filter((node) => node.status === "extra")
    .map((node) => ({ table: node.table, columns: node.liveColumns }));

  // Migration plan: creates in dependency order, then alters, then orphan
  // reviews. Step numbers are assigned in execution order so blockedBy can
  // reference earlier, already-numbered steps.
  const migrationPlan: MigrationStep[] = [];
  const createStepByEntityId = new Map<string, number>();
  let order = 0;

  const { order: topoOrder } = topoOrderEntities(entities);

  for (const entity of topoOrder) {
    const node = nodeByEntityId.get(entity.id);
    if (node?.status !== "missing") continue;
    const physical = resolveTableName(entity, options.overrides);
    const blockedBy = entity.columns
      .filter((column) => column.refEntityId)
      .map((column) => createStepByEntityId.get(column.refEntityId as string))
      .filter((step): step is number => typeof step === "number");
    order += 1;
    createStepByEntityId.set(entity.id, order);
    const description = entity.junction
      ? `Create link table ${physical} joining ${entity.junction.leftTable} and ${entity.junction.rightTable}, derived from many-to-many array references.`
      : `Create table ${physical} (modeled as ${entity.name}).`;
    migrationPlan.push({
      order,
      kind: "create_table",
      target: physical,
      description,
      sql: buildAlterScript(dialectId, entity, undefined, entities, options.overrides),
      blockedBy,
      requiresReview: false,
    });
  }

  for (const entity of topoOrder) {
    const node = nodeByEntityId.get(entity.id);
    if (node?.status !== "drift") continue;
    const physical = resolveTableName(entity, options.overrides);
    const blockedBy = entity.columns
      .filter((column) => column.refEntityId)
      .map((column) => createStepByEntityId.get(column.refEntityId as string))
      .filter((step): step is number => typeof step === "number");
    order += 1;
    migrationPlan.push({
      order,
      kind: "alter_table",
      target: physical,
      description: `Bring live table ${physical} in line with the ${entity.name} model using additive changes.`,
      sql: buildAlterScript(
        dialectId,
        entity,
        findLiveTable(physical),
        entities,
        options.overrides,
      ),
      blockedBy,
      requiresReview: true,
    });
  }

  for (const orphan of orphanTables) {
    order += 1;
    migrationPlan.push({
      order,
      kind: "review_orphan_table",
      target: orphan.table,
      description: `Table ${orphan.table} exists in the database but is not represented by the API model. It is kept as-is; decide whether to surface it as a component schema or leave it internal.`,
      sql: [],
      blockedBy: [],
      requiresReview: true,
    });
  }

  const dialect = DIALECTS[dialectId];
  const quotedTable = (name: string) => {
    const live = findLiveTable(name);
    return live?.schema ? `${dialect.quoteIdent(live.schema)}.${dialect.quoteIdent(live.name)}` : dialect.quoteIdent(name);
  };
  for (const relationship of graph.relationships) {
    if (!hasLive || relationship.enforced || relationship.origin !== "model") continue;
    // CREATE already includes constraints for newly created child tables.
    if (!findLiveTable(relationship.fromTable)) continue;
    migrationPlan.push({order: ++order, kind: "alter_table", target: relationship.fromTable,
      description: "Review orphan rows and key compatibility before adding this foreign key.",
      sql: [`-- REVIEW ONLY: validate existing rows before enforcing the relationship.\n-- ALTER TABLE ${quotedTable(relationship.fromTable)} ADD FOREIGN KEY (${dialect.quoteIdent(relationship.fromColumn)}) REFERENCES ${quotedTable(relationship.toTable)} (${dialect.quoteIdent(relationship.toColumn)})`],
      blockedBy: [],requiresReview: true});
  }
  // Index catalogs are not available from the current bridge. Never claim these are absent.
  const indexes = buildIndexes(dialectId,entities,options.overrides);
  // Tables created in this plan already declare their indexes inline, so a
  // separate CREATE INDEX would be redundant (or fail on a duplicate name).
  const createdTableKeys = new Set(
    migrationPlan
      .filter((step) => step.kind === "create_table")
      .map((step) => tableKey(step.target)),
  );
  indexes.statements.forEach((sql,i) => {
    const index=indexes.indexes[i];
    if (createdTableKeys.has(tableKey(index.table))) return;
    const existing = hasLive && Boolean(findLiveTable(index.table));
    migrationPlan.push({order: ++order,kind:"alter_table",target:index.table,
      description: existing ? "Review index definitions; existing index metadata is not available." : `Create index on ${index.table}.`,
      sql: existing ? [`-- REVIEW ONLY: verify existing indexes and duplicates.\n-- ${sql}`] : [sql],
      blockedBy:[],requiresReview:existing});
  });

  const openQuestions: OpenQuestion[] = [];
  if (!hasLive) {
    openQuestions.push({
      code: "no_live_database",
      severity: "info",
      message:
        "No live database was provided. This is a forward-only plan: every modeled table is reported as missing. Connect a read-only database to reconcile against real tables, columns and foreign keys.",
    });
  }

  for (const entity of entities) {
    const meta = entity.junction;
    if (!meta) continue;
    openQuestions.push({
      code: "junction_table_inferred",
      severity: "info",
      table: meta.table,
      message: `Link table ${meta.table} between ${meta.leftTable} and ${meta.rightTable} was derived from many-to-many array reference(s) ${meta.derivedFrom.join(
        ", ",
      )}. It uses a composite primary key and two foreign keys; confirm the table name and, if a pair can repeat, model an explicit associative schema with a payload instead.`,
    });
  }

  const ddl = buildAllDdl(dialectId, entities, { ifNotExists: true, overrides: options.overrides });
  for (const skipped of ddl.skippedForeignKeys) {    openQuestions.push({
      code: "cyclic_foreign_key_skipped",
      severity: "warning",
      message: `Foreign-key edge ${skipped} would create a dependency cycle, so the constraint was omitted from generated DDL while the column was kept. Define the constraint manually after table creation if needed.`,
    });
  }

  const tableIsLive = (physical: string): boolean =>
    nodeByTableKey.get(tableKey(physical))?.live === true;

  let enforcedRelationships = 0;
  let unenforcedRelationships = 0;
  for (const relationship of graph.relationships) {
    const enforced = relationship.enforced;
    const bothEndsLive =
      tableIsLive(relationship.fromTable) && tableIsLive(relationship.toTable);
    if (hasLive) {
      if (enforced) enforcedRelationships += 1;
      else if (bothEndsLive) unenforcedRelationships += 1;
    }
    if (hasLive && !enforced && bothEndsLive && relationship.origin === "model") {
      openQuestions.push({
        code: "relationship_not_enforced",
        severity: "warning",
        table: relationship.fromTable,
        message: `Modeled relationship ${relationship.fromTable}.${relationship.fromColumn} -> ${relationship.toTable}.${relationship.toColumn} is not enforced by a foreign-key constraint in the live database. Confirm whether the constraint should be added.`,
      });
    }
  }

  for (const orphan of orphanTables) {
    openQuestions.push({
      code: "table_not_in_model",
      severity: "info",
      table: orphan.table,
      message: `Live table ${orphan.table} has no counterpart in the OpenAPI model. It is preserved untouched; reverse-engineer a component schema if the API should expose it.`,
    });
  }

  const modeledNodes = graph.nodes.filter((node) => node.modeled);
  const actionableItems = modeledNodes.reduce(
    (total, node) => total + node.diffs.filter((item) => item.severity === "actionable").length,
    0,
  );
  const warningItems = modeledNodes.reduce(
    (total, node) => total + node.diffs.filter((item) => item.severity === "warning").length,
    0,
  );

  const root = asObject(options.doc);
  const info = asObject(root?.info);
  const spec: ReconciliationSpecSource = {
    ...(typeof info?.title === "string" ? { title: info.title } : {}),
    ...(typeof info?.version === "string" ? { version: info.version } : {}),
    ...(options.specDigest ? { digest: options.specDigest } : {}),
    operationCount: impact.operations.length,
  };

  const database: ReconciliationDatabaseSource = {
    dialect: dialectId,
    connected: hasLive,
    ...(options.database?.name ? { name: options.database.name } : {}),
    ...(options.database?.host ? { host: options.database.host } : {}),
    ...(options.database?.database ? { database: options.database.database } : {}),
    tableCount: liveTables.length,
  };

  const clock = options.now ?? (() => new Date());

  return {
    schemaVersion: RECONCILIATION_SCHEMA_VERSION,
    generatedAt: clock().toISOString(),
    dialect: dialectId,
    source: {
      spec,
      database,
    },
    summary: {
      entities: entities.length,
      modeledTables: entities.length,
      liveTables: liveTables.length,
      relationships: graph.relationships.length,
      enforcedRelationships,
      unenforcedRelationships,
      matched: graph.summary.matched,
      drift: graph.summary.drift,
      missing: graph.summary.missing,
      extra: graph.summary.extra,
      actionableItems,
      warningItems,
    },
    tables,
    orphanTables,
    relationships: graph.relationships,
    migrationPlan,
    openQuestions,
    safeguards: SAFEGUARDS,
  };
}
