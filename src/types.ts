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

export type EntitySource = "schema" | "request" | "response" | "junction";

/**
 * A multi-column index that cannot be expressed by the per-column index rule.
 * Used for the composite key of an associative (link/join) table.
 */
export interface CompositeIndexSpec {
  /** Physical column names, in key order. */
  columns: string[];
  unique: boolean;
  /** Optional explicit constraint/index name; generated when omitted. */
  name?: string;
  /** Why the index was emitted, used by tests and the UI. */
  reason: "junction";
}

/**
 * Provenance for a many-to-many link table that was deterministically derived
 * from array-of-$ref properties in the OpenAPI document rather than written as
 * an explicit component schema.
 */
export interface JunctionMeta {
  /** Physical link table name. */
  table: string;
  /** First parent physical table name (naming order, see junctions.ts). */
  leftTable: string;
  /** Second parent physical table name. */
  rightTable: string;
  /**
   * Document properties that imply the relationship, formatted as
   * "schema:Entity#property", so the inference is fully traceable.
   */
  derivedFrom: string[];
}

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
  /**
   * Physical columns of a composite primary key (associative/link tables).
   * When set, DDL emits PRIMARY KEY (col1, col2) instead of a surrogate key.
   */
  compositePrimaryKey?: string[];
  /** Multi-column indexes in addition to the per-column index rule. */
  compositeIndexes?: CompositeIndexSpec[];
  /** Present only when this entity is a derived many-to-many link table. */
  junction?: JunctionMeta;
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
