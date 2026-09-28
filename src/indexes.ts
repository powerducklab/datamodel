import type { DialectId, ModelColumn, ModelEntity } from "./types";
import { DIALECTS, type Dialect } from "./dialects";
import { topoOrderEntities, type TableNameOverrides, resolveTableName } from "./ddl";

/**
 * Secondary index generation. Every foreign-key column gets an index (MySQL
 * InnoDB creates one implicitly, but SQL Server and Oracle do not), explicit
 * `unique` columns become unique indexes, and email columns are treated as
 * unique by convention. Everything else is left alone rather than guessed.
 */

export interface IndexSpec {
  table: string;
  name: string;
  columns: string[];
  unique: boolean;
  /** Why the index was emitted, used by tests and the UI. */
  reason: "foreign-key" | "unique" | "email" | "junction";
}

const MAX_IDENTIFIER_LENGTH = 60;

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}

function indexName(prefix: string, table: string, column: string): string {
  return `${prefix}_${table}_${column}`.slice(0, MAX_IDENTIFIER_LENGTH);
}

function isEmailColumn(column: ModelColumn): boolean {
  if (column.format === "email") return true;
  return column.columnName.toLowerCase() === "email" ||
    column.columnName.toLowerCase().endsWith("_email");
}

function indexKind(column: ModelColumn): IndexSpec["reason"] | null {
  if (column.primaryKey) return null;
  if (column.unique) return "unique";
  // Email does not imply business uniqueness. Only explicit constraints do.
  if (column.refEntityId) return "foreign-key";
  return null;
}

/** Collect deterministic secondary indexes for one entity. */
export function indexesForEntity(
  entity: ModelEntity,
  overrides?: TableNameOverrides,
): IndexSpec[] {
  const table = resolveTableName(entity, overrides);
  const seen = new Set<string>();
  const indexes: IndexSpec[] = [];
  for (const column of entity.columns) {
    const kind = indexKind(column);
    if (!kind) continue;
    if (seen.has(column.columnName)) continue;
    seen.add(column.columnName);
    const unique = kind === "unique" || kind === "email";
    const prefix = unique ? "uq" : "idx";
    indexes.push({
      table,
      name: sanitizeIdentifier(indexName(prefix, table, column.columnName)),
      columns: [column.columnName],
      unique,
      reason: kind,
    });
  }

  for (const composite of entity.compositeIndexes ?? []) {
    const prefix = composite.unique ? "uq" : "idx";
    const generated = `${prefix}_${table}_${composite.columns.join("_")}`.slice(
      0,
      MAX_IDENTIFIER_LENGTH,
    );
    indexes.push({
      table,
      name: composite.name ?? sanitizeIdentifier(generated),
      columns: composite.columns,
      unique: composite.unique,
      reason: composite.reason,
    });
  }
  return indexes;
}

function indexStatement(dialect: Dialect, spec: IndexSpec): string {
  const uniqueClause = spec.unique ? "UNIQUE " : "";
  const columns = spec.columns.map((column) => dialect.quoteIdent(column)).join(", ");
  return `CREATE ${uniqueClause}INDEX ${dialect.quoteIdent(spec.name)} ON ${dialect.quoteIdent(
    spec.table,
  )} (${columns})`;
}

export interface IndexResult {
  indexes: IndexSpec[];
  statements: string[];
  sql: string;
}

/** Build secondary indexes for every entity, ordered alongside table creation. */
export function buildIndexes(
  dialectId: DialectId,
  entities: ModelEntity[],
  overrides?: TableNameOverrides,
): IndexResult {
  const dialect = DIALECTS[dialectId];
  const { order } = topoOrderEntities(entities);
  const indexes = order.flatMap((entity) => indexesForEntity(entity, overrides));
  const statements = indexes.map((spec) => indexStatement(dialect, spec));
  return {
    indexes,
    statements,
    sql: statements.map((statement) => `${statement}${dialect.endStatement}`).join("\n"),
  };
}
