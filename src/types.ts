/**
 * Data Model domain types. Everything in this folder is pure and free of React
 * and DOM dependencies so the extraction, dialect mapping, DDL generation and
 * sample data logic can be unit-tested and reused by the desktop database
 * integration.
 */

export type DialectId = "mysql" | "sqlserver" | "oracle";

export type JsonCoreType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "unknown";

export type EntitySource = "schema" | "request" | "response";

export interface ModelColumn {
  /** Original JSON property name. */
  name: string;
  /** Physical column name (snake_case). */
  columnName: string;
  jsonType: JsonCoreType;
  format?: string;
  maxLength?: number;
  enumValues?: Array<string | number>;
  primaryKey: boolean;
  nullable: boolean;
  unique: boolean;
  description?: string;
  example?: unknown;
  defaultValue?: unknown;
  /** Target entity id when this column is a foreign key. */
  refEntityId?: string;
}

export interface ModelEntity {
  /** Stable identity: "schema:Product" or "request:POST /orders". */
  id: string;
  /** Logical model name, e.g. Product. */
  name: string;
  /** Default physical table name; users can override it per session. */
  tableName: string;
  source: EntitySource;
  /** Operation reference for request/response sourced entities. */
  ref?: string;
  description?: string;
  columns: ModelColumn[];
}

/** A column as reported by a live database (Phase C desktop integration). */
export interface LiveColumn {
  name: string;
  /** Raw database type, e.g. "varchar(255)" or "bigint". */
  dataType?: string;
  nullable?: boolean;
  isPrimaryKey?: boolean;
}

export interface LiveTable {
  name: string;
  /** Schema/owner for databases that namespace tables (SQL Server). */
  schema?: string;
  columns: LiveColumn[];
}

/**
 * A foreign-key constraint observed in a live database through read-only
 * introspection (information_schema / sys catalogs / Oracle data dictionary).
 * Table names may be schema-qualified ("schema.table").
 */
export interface LiveForeignKey {
  /** Child table that owns the foreign-key column. */
  table: string;
  /** Foreign-key column on the child table. */
  column: string;
  /** Parent table the constraint points to. */
  refTable: string;
  /** Referenced column on the parent table (usually the primary key). */
  refColumn: string;
  /** Raw constraint name when the database reports one. */
  constraintName?: string;
}

/** A live table plus a small read-only sample, used for AI test context. */
export interface LiveTableSample extends LiveTable {
  rows: Array<Record<string, string | number | boolean | null>>;
}
