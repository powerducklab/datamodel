import type { JsonCoreType, ModelColumn, ModelEntity } from "./types";
import { operationEntityName, snakeCase, tableNameFor } from "./naming";
import { augmentWithJunctions } from "./junctions";

/**
 * Extract relational entities from an OpenAPI document.
 *
 * Sources: reusable component schemas, plus inline JSON request/response bodies.
 * $ref / allOf composition is flattened; references between object schemas
 * become foreign-key columns. The extraction is deliberately conservative:
 * anything that is not clearly an object with properties is left out rather
 * than guessed.
 */

const MAX_ENTITIES = 200;
const MAX_COLUMNS = 200;
const MAX_DEPTH = 8;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
const ENVELOPE_KEYS = new Set([
  "data",
  "results",
  "items",
  "list",
  "total",
  "count",
  "page",
  "pages",
  "limit",
  "offset",
  "size",
  "meta",
  "pagination",
]);

type AnyObj = Record<string, any>;

function isObj(v: unknown): v is AnyObj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function resolvePointer(doc: AnyObj, ref: string): AnyObj | null {
  if (!ref.startsWith("#/")) return null;
  let current: any = doc;
  for (const segment of ref.slice(2).split("/")) {
    if (!isObj(current)) return null;
    current = current[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return isObj(current) ? current : null;
}

interface FlatSchema {
  schema: AnyObj;
  /** First direct object $ref encountered while flattening. */
  refId?: string;
}

function flattenSchema(
  raw: unknown,
  doc: AnyObj,
  depth = 0,
  seen: Set<string> = new Set(),
): FlatSchema {
  if (!isObj(raw) || depth > MAX_DEPTH) return { schema: {} };
  if (typeof raw.$ref === "string") {
    if (seen.has(raw.$ref)) return { schema: {} };
    const nextSeen = new Set(seen).add(raw.$ref);
    const target = resolvePointer(doc, raw.$ref);
    if (!target) return { schema: {} };
    const refId = raw.$ref.split("/").pop()?.replace(/~1/g, "/") ?? undefined;
    const nested = flattenSchema(target, doc, depth + 1, nextSeen);
    return { schema: nested.schema, refId: nested.refId ?? refId };
  }

  const branches: AnyObj[] = [];
  if (Array.isArray(raw.allOf)) branches.push(...raw.allOf.filter(isObj));
  if (!branches.length) {
    const choice = pickUnionBranch(raw);
    return choice
      ? flattenSchema(choice, doc, depth + 1, seen)
      : { schema: raw };
  }

  const merged: AnyObj = { ...raw };
  delete merged.allOf;
  merged.properties = { ...(isObj(raw.properties) ? raw.properties : {}) };
  const required = new Set<string>(
    Array.isArray(raw.required) ? raw.required.filter((x) => typeof x === "string") : [],
  );
  let refId: string | undefined;
  for (const branch of branches) {
    const flat = flattenSchema(branch, doc, depth + 1, seen);
    if (flat.refId && !refId) refId = flat.refId;
    if (isObj(flat.schema.properties)) {
      Object.assign(merged.properties, flat.schema.properties);
    }
    if (Array.isArray(flat.schema.required)) {
      flat.schema.required.forEach((r) => required.add(String(r)));
    }
    for (const [key, value] of Object.entries(flat.schema)) {
      if (key === "properties" || key === "required" || key === "allOf") continue;
      if (merged[key] === undefined) merged[key] = value;
    }
  }
  merged.required = [...required];
  return { schema: merged, refId };
}

function pickUnionBranch(raw: AnyObj): AnyObj | null {
  const union = raw.oneOf ?? raw.anyOf;
  if (!Array.isArray(union)) return null;
  for (const branch of union) {
    if (!isObj(branch)) continue;
    if (branch.$ref) return branch;
    const types = Array.isArray(branch.type) ? branch.type : [branch.type];
    if (isObj(branch.properties) || types.includes("object")) return branch;
  }
  return null;
}

function coreType(schema: AnyObj): JsonCoreType {
  const type = Array.isArray(schema.type)
    ? schema.type.find((t) => t !== "null")
    : schema.type;
  if (
    type === "string" ||
    type === "integer" ||
    type === "number" ||
    type === "boolean" ||
    type === "object" ||
    type === "array"
  ) {
    return type;
  }
  if (isObj(schema.properties)) return "object";
  if (schema.enum) {
    return typeof schema.enum[0] === "number" ? "number" : "string";
  }
  return "unknown";
}

function isNullable(schema: AnyObj, required: boolean, primaryKey: boolean): boolean {
  if (primaryKey || required) return false;
  if (schema.nullable === true) return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  // OpenAPI treats properties as optional unless listed in `required`; the
  // relational default for an optional column is nullable.
  return true;
}

function buildColumn(
  key: string,
  rawProp: unknown,
  required: boolean,
  doc: AnyObj,
  depth: number,
): ModelColumn | null {
  const { schema, refId } = flattenSchema(rawProp, doc, depth);
  const primaryKey =
    key.toLowerCase() === "id" || schema["x-primary-key"] === true;
  const jsonType = coreType(schema);

  // A reference to another object is rendered as a foreign-key id column.
  // References to primitive aliases fall through and use the alias type.
  let fkEntityId: string | undefined;
  if (refId && (jsonType === "object" || isObj(schema.properties))) {
    fkEntityId = `schema:${refId}`;
  }

  const column: ModelColumn = {
    name: key,
    columnName: snakeCase(key) || key,
    jsonType: fkEntityId ? "integer" : jsonType,
    ...(fkEntityId ? { format: "int64", refEntityId: fkEntityId } : {}),
    primaryKey,
    nullable: isNullable(schema, required, primaryKey),
    unique: schema.unique === true || schema["x-unique"] === true,
  };
  if (typeof schema.format === "string") column.format = schema.format;
  if (typeof schema.maxLength === "number") column.maxLength = schema.maxLength;
  if (
    Array.isArray(schema.enum) &&
    schema.enum.every((v) => ["string", "number", "boolean"].includes(typeof v))
  ) {
    column.enumValues = schema.enum.slice(0, 100);
  }
  if (typeof schema.description === "string" && schema.description.trim()) {
    column.description = schema.description.trim();
  }
  if (schema.example !== undefined) column.example = schema.example;
  if (schema.default !== undefined) column.defaultValue = schema.default;
  return column;
}

function entityFromObjectSchema(args: {
  id: string;
  name: string;
  source: ModelEntity["source"];
  rawSchema: unknown;
  doc: AnyObj;
  ref?: string;
}): ModelEntity | null {
  const { id, name, source, rawSchema, doc, ref } = args;
  const { schema } = flattenSchema(rawSchema, doc);
  if (!isObj(schema.properties)) return null;
  const required = new Set<string>(
    Array.isArray(schema.required)
      ? schema.required.filter((x) => typeof x === "string")
      : [],
  );
  const columns: ModelColumn[] = [];
  const usedNames = new Set<string>();
  for (const [key, rawProp] of Object.entries(schema.properties)) {
    if (columns.length >= MAX_COLUMNS) break;
    const column = buildColumn(key, rawProp, required.has(key), doc, 0);
    if (!column) continue;
    if (usedNames.has(column.columnName)) continue;
    usedNames.add(column.columnName);
    columns.push(column);
  }
  if (!columns.length) return null;
  const customTableName =
    typeof schema["x-table-name"] === "string" && schema["x-table-name"].trim()
      ? schema["x-table-name"].trim()
      : undefined;
  const entity: ModelEntity = {
    id,
    name,
    tableName: customTableName ?? tableNameFor(name),
    source,
    ...(ref ? { ref } : {}),
    columns,
  };
  if (typeof schema.description === "string" && schema.description.trim()) {
    entity.description = schema.description.trim();
  }
  return entity;
}

function isEnvelope(schema: AnyObj): boolean {
  const keys = Object.keys(schema.properties ?? {});
  if (!keys.length) return false;
  const wrapper = schema.properties.data ?? schema.properties.results ?? schema.properties.items;
  return (
    keys.every((k) => ENVELOPE_KEYS.has(k)) &&
    wrapper &&
    (wrapper.type === "array" || wrapper.$ref)
  );
}

/** Extract all relational entities from a parsed OpenAPI document. */
export function extractEntities(doc: unknown): ModelEntity[] {
  if (!isObj(doc)) return [];
  const entities: ModelEntity[] = [];
  const ids = new Set<string>();

  const add = (entity: ModelEntity | null) => {
    if (!entity || ids.has(entity.id) || entities.length >= MAX_ENTITIES) return;
    ids.add(entity.id);
    entities.push(entity);
  };

  const schemas = isObj(doc.components) && isObj(doc.components.schemas)
    ? doc.components.schemas
    : {};
  for (const name of Object.keys(schemas).sort()) {
    add(
      entityFromObjectSchema({
        id: `schema:${name}`,
        name,
        source: "schema",
        rawSchema: schemas[name],
        doc: doc as AnyObj,
      }),
    );
  }

  const paths = isObj(doc.paths) ? doc.paths : {};
  for (const path of Object.keys(paths).sort()) {
    const pathItem = paths[path];
    if (!isObj(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isObj(operation)) continue;
      const opRef = `${method.toUpperCase()} ${path}`;

      const requestSchema =
        operation.requestBody?.content?.["application/json"]?.schema;
      if (isObj(requestSchema) && !requestSchema.$ref) {
        add(
          entityFromObjectSchema({
            id: `request:${opRef}`,
            name: operationEntityName(method, path, "Request"),
            source: "request",
            rawSchema: requestSchema,
            doc: doc as AnyObj,
            ref: opRef,
          }),
        );
      }

      const responses = isObj(operation.responses) ? operation.responses : {};
      for (const status of Object.keys(responses)) {
        if (!status.startsWith("2")) continue;
        const responseSchema =
          responses[status]?.content?.["application/json"]?.schema;
        if (!isObj(responseSchema) || responseSchema.$ref) continue;
        const { schema } = flattenSchema(responseSchema, doc as AnyObj);
        if (isObj(schema.properties) && !isEnvelope(schema)) {
          add(
            entityFromObjectSchema({
              id: `response:${opRef}:${status}`,
              name: operationEntityName(method, path, "Response"),
              source: "response",
              rawSchema: schema,
              doc: doc as AnyObj,
              ref: opRef,
            }),
          );
        } else if (
          schema.type === "array" &&
          isObj(schema.items) &&
          !schema.items.$ref
        ) {
          add(
            entityFromObjectSchema({
              id: `response:${opRef}:${status}:item`,
              name: operationEntityName(method, path, "Item"),
              source: "response",
              rawSchema: schema.items,
              doc: doc as AnyObj,
              ref: opRef,
            }),
          );
        }
      }
    }
  }

  return augmentWithJunctions(doc, entities);
}
