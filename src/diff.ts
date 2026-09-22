import type { DialectId, LiveTable, ModelColumn, ModelEntity } from "./types";
import { columnTypesCompatible, type TableNameOverrides, resolveTableName } from "./ddl";

/**
 * Structured comparison between an API-derived model entity and an observed
 * database table. The database is treated as a superset on purpose: extra
 * columns (status flags, timestamps, internal indexes) are informational, never
 * turned into destructive statements. Missing columns and type mismatches are
 * the actionable drift that the read-only ALTER suggestions address.
 */

export type DiffSeverity = "actionable" | "warning" | "info";

export type DiffItemKind =
  | "missing_table"
  | "missing_column"
  | "type_mismatch"
  | "nullability"
  | "extra_column";

export interface DiffItem {
  kind: DiffItemKind;
  severity: DiffSeverity;
  /** Modeled column name (missing/type/nullability items). */
  column?: string;
  /** Live column name (extra-column items). */
  liveColumn?: string;
  modelType?: string;
  liveType?: string;
  message: string;
}

export type DiffStatus = "missing" | "drift" | "matched";

export interface SchemaDiff {
  entityId: string;
  entityName: string;
  table: string;
  status: DiffStatus;
  items: DiffItem[];
  actionableCount: number;
}

function findLiveColumn(live: LiveTable, name: string) {
  const wanted = name.toLowerCase();
  return live.columns.find((column) => column.name.toLowerCase() === wanted);
}

/**
 * Compare one modeled entity against an optional live table. `live` is
 * undefined when no table with the modeled physical name exists yet.
 */
export function diffEntityAgainstLive(
  dialectId: DialectId,
  entity: ModelEntity,
  live: LiveTable | undefined,
  overrides?: TableNameOverrides,
): SchemaDiff {
  const table = resolveTableName(entity, overrides);
  const items: DiffItem[] = [];

  if (!live) {
    items.push({
      kind: "missing_table",
      severity: "actionable",
      message: `Table ${table} does not exist in the connected database yet.`,
    });
    return {
      entityId: entity.id,
      entityName: entity.name,
      table,
      status: "missing",
      items,
      actionableCount: 1,
    };
  }

  for (const column of entity.columns) {
    const observed = findLiveColumn(live, column.columnName);
    if (!observed) {
      items.push({
        kind: "missing_column",
        severity: "actionable",
        column: column.columnName,
        modelType: column.jsonType,
        message: `Column ${column.columnName} is modeled but missing from the live table.`,
      });
      continue;
    }
    if (observed.dataType && !columnTypesCompatible(dialectId, column, observed.dataType)) {
      items.push({
        kind: "type_mismatch",
        severity: "actionable",
        column: column.columnName,
        modelType: column.jsonType,
        liveType: observed.dataType,
        message: `Column ${column.columnName} type differs: model expects a ${column.jsonType} value, live column is ${observed.dataType}.`,
      });
    } else if (!column.nullable && observed.nullable === true) {
      items.push({
        kind: "nullability",
        severity: "warning",
        column: column.columnName,
        liveType: observed.dataType,
        message: `Column ${column.columnName} is modeled NOT NULL but the live column is nullable.`,
      });
    }
  }

  const modeledNames = new Set(entity.columns.map((column) => column.columnName.toLowerCase()));
  for (const liveColumn of live.columns) {
    if (!modeledNames.has(liveColumn.name.toLowerCase())) {
      items.push({
        kind: "extra_column",
        severity: "info",
        liveColumn: liveColumn.name,
        liveType: liveColumn.dataType,
        message: `Live column ${liveColumn.name} (${liveColumn.dataType ?? "unknown"}) is not represented in the API model — kept as-is.`,
      });
    }
  }

  const actionableCount = items.filter((item) => item.severity === "actionable").length;
  return {
    entityId: entity.id,
    entityName: entity.name,
    table,
    status: actionableCount > 0 ? "drift" : "matched",
    items,
    actionableCount,
  };
}

export interface ModelColumnSummary {
  name: string;
  jsonType: string;
  format?: string;
  primaryKey: boolean;
  nullable: boolean;
}

/** Compact summary used by the UI and AI context; never includes live data. */
export function summarizeModelColumns(entity: ModelEntity): ModelColumnSummary[] {
  return entity.columns.map((column: ModelColumn) => ({
    name: column.columnName,
    jsonType: column.jsonType,
    format: column.format,
    primaryKey: Boolean(column.primaryKey),
    nullable: Boolean(column.nullable),
  }));
}
