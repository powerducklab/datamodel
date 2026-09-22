import type { DialectId, ModelColumn, ModelEntity } from "./types";
import { DIALECTS, type Dialect } from "./dialects";
import { topoOrderEntities, type TableNameOverrides, resolveTableName } from "./ddl";

/**
 * Deterministic INSERT statements for fresh deployments. Parent tables are
 * inserted first so foreign keys resolve, values never depend on randomness or
 * time, and every literal is rendered for the target dialect. The database is
 * never touched here — callers only copy or download the script.
 */

export interface InsertResult {
  statements: string[];
  sql: string;
  rowCount: number;
}

function quoteStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function exampleString(column: ModelColumn, row: number): string {
  const explicit = column.example;
  if (typeof explicit === "string" && explicit.trim()) {
    return row === 1 ? explicit : `${explicit} ${row}`;
  }
  if (typeof explicit === "number" || typeof explicit === "boolean") {
    return String(explicit);
  }
  const base = column.columnName.replace(/_/g, " ").trim();
  const label = base
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return label ? `${label} ${row}` : `Value ${row}`;
}

/**
 * Render one deterministic value as a raw SQL token (already quoted where the
 * type requires it).
 */
function sqlLiteral(column: ModelColumn, row: number, total: number): string {
  const explicit = column.example;

  if (column.refEntityId) {
    // Parent tables receive rows 1..total in the same order, so a value in that
    // range always resolves to an existing primary key.
    return String(((row + 1) % total) + 1);
  }

  if (column.primaryKey) return String(row);

  if (column.jsonType === "boolean") {
    const truthy = typeof explicit === "boolean" ? explicit : row % 2 === 0;
    return truthy ? "1" : "0";
  }

  if (column.jsonType === "integer") {
    if (typeof explicit === "number" && Number.isFinite(explicit)) {
      return String(Math.trunc(explicit) + row);
    }
    return String(row * 10 + 1);
  }

  if (column.jsonType === "number") {
    if (typeof explicit === "number" && Number.isFinite(explicit)) {
      return String(Number((explicit + row).toFixed(2)));
    }
    return (row * 1.5 + 0.99).toFixed(2);
  }

  if (column.jsonType === "object") {
    if (!column.nullable) return quoteStringLiteral("{}");
    return "NULL";
  }
  if (column.jsonType === "array") {
    if (!column.nullable) return quoteStringLiteral("[]");
    return "NULL";
  }

  // Strings (including date/time/binary formats) are always quoted.
  let value = exampleString(column, row);
  if (column.maxLength && value.length > column.maxLength) {
    value = value.slice(0, Math.max(1, column.maxLength));
  }
  return quoteStringLiteral(value);
}

function columnsForInsert(entity: ModelEntity): ModelColumn[] {
  return entity.columns;
}

function insertStatement(
  dialect: Dialect,
  entity: ModelEntity,
  table: string,
  rows: number,
): string[] {
  const columns = columnsForInsert(entity);
  const columnList = columns.map((column) => dialect.quoteIdent(column.columnName)).join(", ");
  const renderedRows: string[] = [];
  for (let row = 1; row <= rows; row += 1) {
    const values = columns
      .map((column) => sqlLiteral(column, row, rows))
      .join(", ");
    renderedRows.push(`  (${values})`);
  }
  const tableRef = dialect.quoteIdent(table);

  // Oracle (pre-23c) accepts only one VALUES tuple per INSERT; MySQL and SQL
  // Server support a multi-row VALUES clause.
  if (dialect.id === "oracle") {
    return renderedRows.map(
      (tuple) =>
        `INSERT INTO ${tableRef} (${columnList}) VALUES\n${tuple}${dialect.endStatement}`,
    );
  }
  return [
    `INSERT INTO ${tableRef} (${columnList}) VALUES\n${renderedRows.join(",\n")}${dialect.endStatement}`,
  ];
}

/**
 * Build sample INSERT statements for every entity in foreign-key order.
 * @param count rows per table (clamped to 1..20); default 5
 */
export function buildInsertStatements(
  dialectId: DialectId,
  entities: ModelEntity[],
  count = 5,
  overrides?: TableNameOverrides,
): InsertResult {
  const dialect = DIALECTS[dialectId];
  const requested = Number.isFinite(count) ? Math.trunc(count) : 5;
  const rows = Math.max(1, Math.min(20, requested));
  const { order } = topoOrderEntities(entities);
  // Derived many-to-many link tables are skipped: their rows must pair real
  // parent keys, and deterministic random pairs would collide on the composite
  // primary key. Explicit associative schemas (source "schema") still seed.
  const insertable = order.filter((entity) => entity.source !== "junction");
  const statements: string[] = [];
  for (const entity of insertable) {
    const table = resolveTableName(entity, overrides);
    statements.push(...insertStatement(dialect, entity, table, rows));
  }
  return {
    statements,
    sql: statements.join("\n"),
    rowCount: insertable.length * rows,
  };
}
