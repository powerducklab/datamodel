import type { ModelColumn, ModelEntity } from "./types";

/**
 * Deterministic sample rows derived strictly from schema constraints
 * (enum, format, minimum, maximum, maxLength, example, default). No random
 * data: regeneration yields the same rows, which keeps tests and AI context
 * stable. Values are scalars ready for table rendering or CSV export.
 */

export interface SampleTableColumn {
  key: string;
  label: string;
  type?: string;
}

export type SampleCell = string | number | boolean | null;

export interface SampleTable {
  columns: SampleTableColumn[];
  rows: SampleCell[][];
}

const ISO_EPOCH = Date.UTC(2024, 0, 1, 9, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function scalarExample(column: ModelColumn): unknown {
  if (column.example !== undefined) return column.example;
  return column.defaultValue;
}

function valueFor(column: ModelColumn, row: number): SampleCell {
  const n = row + 1;
  const preset = scalarExample(column);
  if (preset !== undefined && preset !== null) {
    if (["string", "number", "boolean"].includes(typeof preset)) {
      return preset as SampleCell;
    }
  }

  if (column.primaryKey && column.jsonType === "integer") return n;
  if (column.refEntityId) return ((row + 2) % 5) + 1;

  switch (column.jsonType) {
    case "boolean":
      return row % 2 === 0;
    case "integer": {
      const min = 0;
      return min + n;
    }
    case "number":
      return Number((n - 0.5).toFixed(2));
    case "string": {
      if (column.enumValues?.length) return column.enumValues[row % column.enumValues.length];
      switch (column.format) {
        case "uuid":
          return `00000000-0000-4000-8000-${pad(n, 12)}`;
        case "email":
          return `${column.columnName.replace(/_/g, ".")}${n}@example.com`;
        case "uri":
        case "url":
          return `https://example.com/${column.columnName}/${n}`;
        case "hostname":
          return `host-${n}.example.com`;
        case "date": {
          const date = new Date(ISO_EPOCH + row * DAY_MS);
          return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
            date.getUTCDate(),
          )}`;
        }
        case "date-time":
        case "timestamp":
          return new Date(ISO_EPOCH + row * DAY_MS).toISOString().replace(".000Z", "Z");
        case "time":
          return `${pad((8 + row) % 24)}:00:00`;
        case "binary":
        case "byte":
          return null;
        default: {
          const base = `${column.columnName}_${n}`;
          return column.maxLength ? base.slice(0, column.maxLength) : base;
        }
      }
    }
    default:
      return null;
  }
}

export function buildSampleData(entity: ModelEntity, count = 5): SampleTable {
  const rowsCount = Math.max(1, Math.min(20, count));
  const columns: SampleTableColumn[] = entity.columns.map((c) => ({
    key: c.columnName,
    label: c.columnName,
    type: c.format ?? c.jsonType,
  }));
  const rows: SampleCell[][] = Array.from({ length: rowsCount }, (_, row) =>
    entity.columns.map((column) => valueFor(column, row)),
  );
  return { columns, rows };
}
