import type { LiveColumn, LiveTable } from "./types";
import { singularize } from "./naming";

/**
 * Reverse engineering: turn selected live database columns into an OpenAPI
 * component schema and a JSON Patch that adds it under components.schemas. This
 * is the read-only counterpart of DDL generation — the database is the source
 * of truth, and the user explicitly chooses which columns to surface to the
 * API layer (internal status/timestamp columns can be left out).
 */

export interface JsonPatchOp {
  op: "add" | "replace" | "remove";
  path: (string | number)[];
  value?: unknown;
}

export interface InferredProperty {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array";
  format?: string;
  maxLength?: number;
  enum?: string[];
}

const INTEGER_TYPES =
  /^(tinyint|smallint|mediumint|integer|int|bigint|serial|bigserial|smallserial|number\(\d+,\s*0\)|numeric\(\d+,\s*0\)|decimal\(\d+,\s*0\))/;
const NUMBER_TYPES =
  /^(decimal|numeric|number|float|double|real|money|smallmoney|binary_float|binary_double|dec|fixed)/;
const DATE_TIME_TYPES =
  /^(datetime2?|datetimeoffset|smalldatetime|timestamp(\(\d+\))?|timestamptz|timestamp with time zone|timestamp without time zone)/;
const DATE_TYPES = /^(date|smalldatetime)$/;
const TIME_TYPES = /^(time(\(\d+\))?|timetz|time with time zone)/;
const BINARY_TYPES = /^(blob|tinyblob|mediumblob|longblob|binary|varbinary|image|bytea|raw|long raw)/;
const JSON_TYPES = /^(json|jsonb)/;
const TEXT_TYPES =
  /^(char|nchar|varchar|nvarchar|varchar2|nvarchar2|character varying|character|text|ntext|clob|nclob|long|string|citext|tinytext|mediumtext|longtext)/;

function parseLength(dataType: string): number | undefined {
  const match = /\(\s*(\d+)\s*\)/.exec(dataType);
  if (!match) return undefined;
  const length = Number(match[1]);
  if (!Number.isFinite(length) || length <= 0 || length > 10000) return undefined;
  return length;
}

function parseEnumValues(dataType: string): string[] | undefined {
  const match = /^enum\s*\((.*)\)$/i.exec(dataType.trim());
  if (!match) return undefined;
  return match[1]
    .split(",")
    .map((part) => part.trim().replace(/^'(.*)'$/, "$1"))
    .filter(Boolean);
}

/** Map an observed SQL type declaration to an OpenAPI property schema. */
export function inferPropertyFromSqlType(dataType: string | undefined): InferredProperty {
  if (!dataType) return { type: "string" };
  const raw = dataType.trim().toLowerCase();
  const compact = raw.replace(/\s+/g, "");

  if (compact === "bit" || compact === "tinyint(1)" || compact === "bool" || compact === "boolean") {
    return { type: "boolean" };
  }
  if (compact === "uniqueidentifier" || compact === "uuid") {
    return { type: "string", format: "uuid" };
  }
  if (JSON_TYPES.test(compact)) {
    return { type: "object" };
  }
  if (DATE_TIME_TYPES.test(compact)) {
    return { type: "string", format: "date-time" };
  }
  if (TIME_TYPES.test(compact)) {
    return { type: "string", format: "time" };
  }
  if (DATE_TYPES.test(compact)) {
    return { type: "string", format: "date" };
  }
  if (BINARY_TYPES.test(compact)) {
    return { type: "string", format: "byte" };
  }
  if (INTEGER_TYPES.test(compact)) {
    return { type: "integer", format: compact.includes("bigint") ? "int64" : "int32" };
  }
  if (NUMBER_TYPES.test(compact)) {
    return { type: "number" };
  }
  const enumValues = parseEnumValues(raw);
  if (enumValues) {
    return { type: "string", enum: enumValues };
  }
  if (TEXT_TYPES.test(compact) || compact === "xml") {
    const property: InferredProperty = { type: "string" };
    const length = parseLength(compact);
    if (length) property.maxLength = length;
    return property;
  }
  return { type: "string" };
}

/** Convert a physical table name to a PascalCase, singular component name. */
export function componentNameFromTable(tableName: string): string {
  const withoutSchema = tableName.includes(".")
    ? tableName.slice(tableName.lastIndexOf(".") + 1)
    : tableName;
  const parts = withoutSchema
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const pascal = parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const singular = singularize(pascal);
  const normalized = singular.charAt(0).toUpperCase() + singular.slice(1);
  return normalized || "GeneratedComponent";
}

export interface ComponentSchema {
  type: "object";
  properties: Record<string, InferredProperty & { "x-primary-key"?: boolean }>;
  required: string[];
  "x-table-name"?: string;
}

/**
 * Build an OpenAPI schema object from the chosen live columns. Column order is
 * preserved, primary keys are annotated and non-nullable columns are required.
 */
export function buildComponentSchema(
  table: LiveTable,
  selectedColumnNames: string[],
): ComponentSchema {
  const wanted = new Set(selectedColumnNames.map((name) => name.toLowerCase()));
  const properties: ComponentSchema["properties"] = {};
  const required: string[] = [];

  for (const column of table.columns) {
    if (!wanted.has(column.name.toLowerCase())) continue;
    const property = inferPropertyFromSqlType(column.dataType);
    if (column.isPrimaryKey) {
      properties[column.name] = { ...property, "x-primary-key": true };
    } else {
      properties[column.name] = { ...property };
    }
    if (column.nullable === false && !column.isPrimaryKey) {
      required.push(column.name);
    }
  }

  const schema: ComponentSchema = {
    type: "object",
    properties,
    required,
  };
  const physical = table.schema ? `${table.schema}.${table.name}` : table.name;
  schema["x-table-name"] = physical;
  return schema;
}

/** JSON Patch to add (or replace) a component schema. */
export function buildComponentPatch(
  componentName: string,
  schema: ComponentSchema,
  options: { exists?: boolean } = {},
): JsonPatchOp[] {
  return [
    {
      op: options.exists ? "replace" : "add",
      path: ["components", "schemas", componentName],
      value: schema,
    },
  ];
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Patch ops that create missing `components` and `components.schemas` parent
 * maps so the schema add op never fails with "Missing parent path" on a spec
 * whose components section was never created.
 */
export function ensureSchemasParentOps(doc: unknown): JsonPatchOp[] {
  if (!isPlainMap(doc)) return [];
  const ops: JsonPatchOp[] = [];
  const components = doc.components;
  if (!isPlainMap(components)) {
    ops.push({ op: "add", path: ["components"], value: {} });
    ops.push({ op: "add", path: ["components", "schemas"], value: {} });
    return ops;
  }
  if (!isPlainMap(components.schemas)) {
    ops.push({ op: "add", path: ["components", "schemas"], value: {} });
  }
  return ops;
}

/** Suggest a component name that does not collide with existing schema names. */
export function uniqueComponentName(base: string, existingNames: Iterable<string>): string {
  const taken = new Set(Array.from(existingNames).map((name) => name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let counter = 2;
  while (taken.has(`${base}${counter}`.toLowerCase())) counter += 1;
  return `${base}${counter}`;
}

/** Live columns in stable selection order. */
export function selectableColumns(table: LiveTable): LiveColumn[] {
  return table.columns;
}

export interface ComponentMergePlan {
  /** Final schema name (de-collided against existing schemas by the caller). */
  name: string;
  /** True when a schema with this name already exists and will be merged into. */
  exists: boolean;
  /** Property names the patch adds (absent on the existing schema). */
  addedProperties: string[];
  /** Existing properties kept untouched so they are never overwritten. */
  skippedProperties: string[];
  /** Required entries the patch appends (existing entries are preserved). */
  addedRequired: string[];
  /** Ops scoped strictly to components.schemas.<name>; empty when nothing changes. */
  ops: JsonPatchOp[];
  /** True when the plan changes nothing at all. */
  empty: boolean;
}

function asObjectMap(value: unknown): Record<string, unknown> | undefined {
  return isPlainMap(value) ? (value as Record<string, unknown>) : undefined;
}

function existingSchemaMap(doc: unknown, name: string): Record<string, unknown> | undefined {
  const root = asObjectMap(doc);
  const schemas = asObjectMap(asObjectMap(root?.components)?.schemas);
  return asObjectMap(schemas?.[name]);
}

/**
 * Build a non-destructive patch plan for a reverse-engineered component.
 *
 * A brand-new schema is added wholesale (with parent scaffolding). When the
 * schema already exists the plan MERGES instead of replacing: it adds only
 * missing properties, leaves every existing property untouched, and appends new
 * required entries without removing current ones. The caller renders this plan
 * for review before applying it (see §10.7).
 */
export function planComponentPatch(
  doc: unknown,
  componentName: string,
  schema: ComponentSchema,
): ComponentMergePlan {
  const existing = existingSchemaMap(doc, componentName);

  // Brand-new schema: add it wholesale together with any missing parents.
  if (!existing) {
    const ops: JsonPatchOp[] = [
      ...ensureSchemasParentOps(doc),
      ...buildComponentPatch(componentName, schema, { exists: false }),
    ];
    return {
      name: componentName,
      exists: false,
      addedProperties: Object.keys(schema.properties),
      skippedProperties: [],
      addedRequired: [...schema.required],
      ops,
      empty: false,
    };
  }

  const base = ["components", "schemas", componentName];
  const ops: JsonPatchOp[] = [];
  const addedProperties: string[] = [];
  const skippedProperties: string[] = [];
  const incoming = Object.entries(schema.properties);
  const existingProperties = asObjectMap(existing.properties);

  if (existingProperties) {
    for (const [propertyName, propertySchema] of incoming) {
      if (Object.prototype.hasOwnProperty.call(existingProperties, propertyName)) {
        skippedProperties.push(propertyName);
        continue;
      }
      ops.push({
        op: "add",
        path: [...base, "properties", propertyName],
        value: propertySchema,
      });
      addedProperties.push(propertyName);
    }
  } else if (Object.prototype.hasOwnProperty.call(existing, "properties")) {
    // A "properties" key exists but is not an object map; never clobber it.
    skippedProperties.push(...incoming.map(([propertyName]) => propertyName));
  } else if (incoming.length) {
    // The object schema has no properties map yet: create it in one op.
    ops.push({
      op: "add",
      path: [...base, "properties"],
      value: schema.properties,
    });
    addedProperties.push(...incoming.map(([propertyName]) => propertyName));
  }

  // Merge required additively, preserving the schema's current entries.
  const currentRequired = Array.isArray(existing.required)
    ? (existing.required as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];
  const addedRequired = schema.required.filter((entry) => !currentRequired.includes(entry));
  if (addedRequired.length) {
    const mergedRequired = [...currentRequired, ...addedRequired];
    ops.push(
      Array.isArray(existing.required)
        ? { op: "replace", path: [...base, "required"], value: mergedRequired }
        : { op: "add", path: [...base, "required"], value: mergedRequired },
    );
  }

  return {
    name: componentName,
    exists: true,
    addedProperties,
    skippedProperties,
    addedRequired,
    ops,
    empty: ops.length === 0,
  };
}
