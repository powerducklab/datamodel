import type {
  DialectId,
  LiveColumn,
  LiveTable,
  ModelColumn,
  ModelEntity,
} from "./types";
import { DIALECTS, type Dialect } from "./dialects";

/**
 * DDL generation. Every statement is derived from host-validated entities;
 * the model never writes SQL directly. Foreign keys are emitted only for
 * tables present in the same extraction set, ordered by dependency.
 */

export type TableNameOverrides = Record<string, string>;

export interface DdlResult {
  statements: string[];
  /** Foreign-key edges omitted because they formed a dependency cycle. */
  skippedForeignKeys: string[];
  sql: string;
}

/** Resolve the physical table name, honoring a session override. */
export function resolveTableName(entity: ModelEntity, overrides?: TableNameOverrides): string {
  return overrides?.[entity.id]?.trim() || entity.tableName;
}

function primaryKeyColumn(entity: ModelEntity): ModelColumn | undefined {
  return entity.columns.find((c) => c.primaryKey);
}

function columnDefinition(
  dialect: Dialect,
  column: ModelColumn,
): string {
  const name = dialect.quoteIdent(column.columnName);
  const type = dialect.columnType(column);
  if (column.primaryKey && column.jsonType === "integer" && !column.refEntityId) {
    return `${name} ${dialect.identityType} NOT NULL PRIMARY KEY`;
  }
  const parts = [name, type, column.nullable ? "NULL" : "NOT NULL"];
  if (column.unique) parts.push("UNIQUE");
  return parts.join(" ");
}

function fkConstraint(
  dialect: Dialect,
  entity: ModelEntity,
  column: ModelColumn,
  target: ModelEntity,
  overrides?: TableNameOverrides,
): string {
  const targetColumn = primaryKeyColumn(target)?.columnName ?? "id";
  const constraint = `fk_${resolveTableName(entity, overrides)}_${column.columnName}`
    .slice(0, 60)
    .replace(/[^a-zA-Z0-9_]/g, "_");
  return `CONSTRAINT ${dialect.quoteIdent(constraint)} FOREIGN KEY (${dialect.quoteIdent(
    column.columnName,
  )}) REFERENCES ${dialect.quoteIdent(resolveTableName(target, overrides))} (${dialect.quoteIdent(
    targetColumn,
  )})`;
}

function createTableStatement(
  dialect: Dialect,
  entity: ModelEntity,
  byId: Map<string, ModelEntity>,
  overrides: TableNameOverrides | undefined,
  skipFkEdges: Set<string>,
  ifNotExists: boolean,
): string {
  const table = dialect.quoteIdent(resolveTableName(entity, overrides));
  const lines = entity.columns.map((column) => `  ${columnDefinition(dialect, column)}`);

  const pk = primaryKeyColumn(entity);
  if (entity.compositePrimaryKey?.length) {
    const composite = entity.compositePrimaryKey
      .map((column) => dialect.quoteIdent(column))
      .join(", ");
    lines.push(`  PRIMARY KEY (${composite})`);
  } else if (pk && !(pk.jsonType === "integer" && !pk.refEntityId)) {
    lines.push(`  PRIMARY KEY (${dialect.quoteIdent(pk.columnName)})`);
  }

  for (const column of entity.columns) {
    if (!column.refEntityId) continue;
    const edge = `${entity.id}->${column.refEntityId}`;
    if (skipFkEdges.has(edge)) continue;
    const target = byId.get(column.refEntityId);
    if (target) lines.push(`  ${fkConstraint(dialect, entity, column, target, overrides)}`);
  }

  const clause = ifNotExists && dialect.id === "mysql" ? " TABLE IF NOT EXISTS " : " TABLE ";
  return `CREATE${clause}${table} (\n${lines.join(",\n")}\n)`;
}

/**
 * Order entities so referenced tables are created first. Edges that would
 * create a cycle are omitted (the column stays, only the FK constraint goes).
 */
export function topoOrderEntities(entities: ModelEntity[]): {
  order: ModelEntity[];
  skipped: Set<string>;
} {
  return topoOrder(entities);
}

function topoOrder(entities: ModelEntity[]): {
  order: ModelEntity[];
  skipped: Set<string>;
} {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const order: ModelEntity[] = [];
  const visited = new Set<string>();
  const gray = new Set<string>();
  const skipped = new Set<string>();

  const visit = (entity: ModelEntity) => {
    if (visited.has(entity.id)) return;
    if (gray.has(entity.id)) return;
    gray.add(entity.id);
    for (const column of entity.columns) {
      if (!column.refEntityId) continue;
      const target = byId.get(column.refEntityId);
      if (!target) {
        skipped.add(`${entity.id}->${column.refEntityId}`);
        continue;
      }
      if (gray.has(target.id)) {
        skipped.add(`${entity.id}->${target.id}`);
        continue;
      }
      visit(target);
    }
    gray.delete(entity.id);
    visited.add(entity.id);
    order.push(entity);
  };

  for (const entity of entities) visit(entity);
  return { order, skipped };
}

export function buildAllDdl(
  dialectId: DialectId,
  entities: ModelEntity[],
  options: { ifNotExists?: boolean; overrides?: TableNameOverrides } = {},
): DdlResult {
  const dialect = DIALECTS[dialectId];
  const byId = new Map(entities.map((e) => [e.id, e]));
  const { order, skipped } = topoOrder(entities);
  const statements = order.map((entity) =>
    createTableStatement(
      dialect,
      entity,
      byId,
      options.overrides,
      skipped,
      options.ifNotExists ?? true,
    ),
  );
  // Break cycles during CREATE, then add those constraints after every table exists.
  const unresolved = new Set(skipped);
  for (const entity of entities) for (const column of entity.columns) {
    const edge = `${entity.id}->${column.refEntityId}`;
    const target = column.refEntityId ? byId.get(column.refEntityId) : undefined;
    if (target && skipped.has(edge)) {
      statements.push(`ALTER TABLE ${dialect.quoteIdent(resolveTableName(entity, options.overrides))} ADD ${fkConstraint(dialect, entity, column, target, options.overrides)}`);
      unresolved.delete(edge);
    }
  }
  return {
    statements,
    skippedForeignKeys: [...unresolved],
    sql:
      `-- Generated by PowerDuck (${dialect.label})\n` +
      statements.map((s) => `${s}${dialect.endStatement}`).join("\n\n") +
      "\n",
  };
}

export function buildTableDdl(
  dialectId: DialectId,
  entity: ModelEntity,
  entities: ModelEntity[],
  options: { ifNotExists?: boolean; overrides?: TableNameOverrides } = {},
): string {
  const dialect = DIALECTS[dialectId];
  const byId = new Map(entities.map((e) => [e.id, e]));
  const { skipped } = topoOrder(entities);
  return createTableStatement(
    dialect,
    entity,
    byId,
    options.overrides,
    skipped,
    options.ifNotExists ?? false,
  );
}

const TYPE_GROUPS: string[][] = [
  ["INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "MEDIUMINT", "NUMBER"],
  ["DECIMAL", "NUMERIC"],
  ["FLOAT", "REAL", "DOUBLE", "BINARY_FLOAT", "BINARY_DOUBLE"],
  ["VARCHAR", "NVARCHAR", "VARCHAR2", "CHAR", "NCHAR", "CHARACTER VARYING"],
  ["TEXT", "CLOB", "NCLOB", "LONGTEXT", "MEDIUMTEXT", "TINYTEXT", "NVARCHAR(MAX)", "VARCHAR(MAX)"],
  ["DATETIME", "DATETIME2", "TIMESTAMP", "DATETIME(6)", "TIMESTAMP(6)"],
  ["JSON"],
  ["BIT"],
  ["DATE"],
  ["TIME"],
  ["BLOB", "VARBINARY", "VARBINARY(MAX)", "BINARY"],
  ["ENUM"],
  ["UNIQUEIDENTIFIER"],
];

function typeSignature(sqlType: string): { group: string; length?: string } {
  const normalized = sqlType.trim().toUpperCase().replace(/\s+/g, " ");
  const match = /^([A-Z0-9 ]+?)(?:\(([^)]*)\))?$/.exec(normalized);
  const base = (match?.[1] ?? normalized).trim();
  const length = match?.[2]?.trim();
  const group = TYPE_GROUPS.find((members) => members.includes(base)) ?? base;
  return { group: Array.isArray(group) ? group[0] : group, length };
}

function typesCompatible(modelType: string, liveType: string): boolean {
  const a = typeSignature(modelType);
  const b = typeSignature(liveType);
  if (a.group !== b.group) return false;
  if (a.length === undefined || b.length === undefined) return true;
  return a.length.replace(/\s/g, "") === b.length.replace(/\s/g, "");
}

/**
 * Public type comparison used by the live-schema diff report. Returns true when
 * the modeled column type and the observed database type are in the same
 * compatibility group (lengths must match when both declare them).
 */
export function columnTypesCompatible(
  dialectId: DialectId,
  column: ModelColumn,
  liveType: string,
): boolean {
  const dialect = DIALECTS[dialectId];
  return typesCompatible(dialect.columnType(column), liveType);
}

function liveMatch(live: LiveTable, column: ModelColumn): LiveColumn | undefined {
  const wanted = column.columnName.toLowerCase();
  return live.columns.find((c) => c.name.toLowerCase() === wanted);
}

/**
 * Minimal synchronization script against a live table (Phase C desktop
 * integration). Missing tables become CREATE statements; missing columns are
 * added; mismatched types are altered. Nothing here executes against the
 * database.
 */
export function buildAlterScript(
  dialectId: DialectId,
  entity: ModelEntity,
  live: LiveTable | undefined,
  entities: ModelEntity[],
  overrides?: TableNameOverrides,
): string[] {
  const dialect = DIALECTS[dialectId];
  const table = live?.schema ? `${dialect.quoteIdent(live.schema)}.${dialect.quoteIdent(live.name)}` : dialect.quoteIdent(resolveTableName(entity, overrides));
  if (!live) {
    return [buildTableDdl(dialectId, entity, entities, { overrides })];
  }

  const statements: string[] = [];
  for (const column of entity.columns) {
    const existing = liveMatch(live, column);
    const definition = columnDefinition(dialect, column);
    if (!existing) {
      const proposed = dialect.id === "oracle" ? `ALTER TABLE ${table} ADD (${definition})`
        : `ALTER TABLE ${table} ADD${dialect.id === "mysql" ? " COLUMN" : ""} ${definition}`;
      statements.push(!column.nullable || column.primaryKey || column.unique
        ? `-- REVIEW ONLY: existing rows require a backfill and constraint review.\n-- ${proposed}` : proposed);
    } else if (existing.dataType && !typesCompatible(dialect.columnType(column), existing.dataType)) {
      // Narrowing, identity and constraint changes require data/profile-specific review.
      const proposed = dialect.id === "mysql"
        ? `ALTER TABLE ${table} MODIFY COLUMN ${definition}`
        : dialect.id === "oracle" ? `ALTER TABLE ${table} MODIFY (${definition})`
        : `ALTER TABLE ${table} ALTER COLUMN ${definition}`;
      statements.push(`-- REVIEW ONLY: type change may truncate data or alter constraints.\n-- ${proposed}`);

    }
  }
  return statements;
}
