import type { CompositeIndexSpec, ModelColumn, ModelEntity } from "./types";
import { pascalCase, pluralize, singularize, snakeCase } from "./naming";

/**
 * Deterministic many-to-many derivation.
 *
 * The relational engine never invents a relationship out of thin air. A link
 * (join) table is emitted only when the OpenAPI document contains an explicit,
 * high-confidence signal:
 *
 *  1. Array reference. A component schema declares a property whose value is an
 *     array of component $ref (e.g. `User.products: Product[]`) and the property
 *     is literally the plural form of the target resource. A child collection
 *     such as `Order.items: OrderItem[]` is intentionally NOT a link table:
 *     when the child schema references the parent back it is a one-to-many, and
 *     generic collection names ("items", "records") never imply many-to-many.
 *
 *  2. Explicit associative schema. A component schema that is a pure link table
 *     (exactly two distinct foreign keys and no business payload) gets a
 *     composite primary key, or a composite unique index when it also carries a
 *     surrogate id. Associative tables with a business payload (e.g. an order
 *     line with quantity and price) are left to explicit modeling.
 *
 * Derived link tables follow the Rails habtm convention: the two plural table
 * names sorted alphabetically and joined with "_" (products + users ->
 * `products_users`), with composite primary key (product_id, user_id) and one
 * foreign key per parent.
 */

type AnyObj = Record<string, unknown>;

const SCHEMA_REF_PREFIX = "#/components/schemas/";
const MAX_JUNCTIONS = 100;

const AUDIT_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "deleted_at",
  "created_on",
  "updated_on",
  "deleted_on",
  "create_time",
  "update_time",
  "create_date",
  "update_date",
]);

function isObj(value: unknown): value is AnyObj {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function refToSchemaName(ref: unknown): string | undefined {
  if (typeof ref !== "string" || !ref.startsWith(SCHEMA_REF_PREFIX)) return undefined;
  const name = ref.slice(SCHEMA_REF_PREFIX.length);
  return name ? name.replace(/~1/g, "/").replace(/~0/g, "~") : undefined;
}

function resolvePointer(doc: AnyObj, ref: string): AnyObj | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = doc;
  for (const segment of ref.slice(2).split("/")) {
    if (!isObj(current)) return undefined;
    current = current[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return isObj(current) ? current : undefined;
}

/**
 * Merge the `properties` maps reachable from a schema node, following `$ref`
 * and `allOf` so array references declared via composition are still seen.
 * oneOf/anyOf branches are intentionally ignored to avoid speculative merges.
 */
function collectProperties(
  raw: unknown,
  doc: AnyObj,
  out: Map<string, unknown>,
  seen: Set<string> = new Set(),
  depth = 0,
): void {
  if (!isObj(raw) || depth > 8) return;
  if (typeof raw.$ref === "string") {
    if (seen.has(raw.$ref)) return;
    const nextSeen = new Set(seen).add(raw.$ref);
    collectProperties(resolvePointer(doc, raw.$ref), doc, out, nextSeen, depth + 1);
    return;
  }
  if (isObj(raw.properties)) {
    for (const [key, value] of Object.entries(raw.properties)) out.set(key, value);
  }
  if (Array.isArray(raw.allOf)) {
    for (const branch of raw.allOf) collectProperties(branch, doc, out, seen, depth + 1);
  }
}

/** Return the referenced component schema name of an `array items.$ref`, if any. */
function arrayItemRefName(prop: unknown, doc: AnyObj): string | undefined {
  if (!isObj(prop) || prop.type !== "array" || !isObj(prop.items)) return undefined;
  const items = prop.items;
  const direct = refToSchemaName(items.$ref);
  if (direct) return direct;
  if (Array.isArray(items.allOf)) {
    for (const branch of items.allOf) {
      const name = refToSchemaName(isObj(branch) ? branch.$ref : undefined);
      if (name) return name;
    }
  }
  return undefined;
}

function primaryKeyColumn(entity: ModelEntity): ModelColumn | undefined {
  return entity.columns.find((column) => column.primaryKey);
}

function camelCase(snake: string): string {
  return snake
    .split("_")
    .filter(Boolean)
    .map((part, index) =>
      index === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
}

/**
 * A plural-form property (User.products -> products) naming the target resource
 * is the high-confidence signal for a direct many-to-many. Generic collection
 * names and child-detail names never qualify.
 */
function propertyNamesTargetResource(propName: string, target: ModelEntity): boolean {
  const normalized = snakeCase(propName);
  if (normalized === target.tableName) return true;
  return propName.trim().toLowerCase() === pluralize(target.name).toLowerCase();
}

interface PairSignal {
  left: ModelEntity;
  right: ModelEntity;
  sources: Set<string>;
}

/** Annotate a pure associative schema with a composite key or unique index. */
function annotateAssociative(
  entity: ModelEntity,
  byId: Map<string, ModelEntity>,
): ModelEntity {
  if (entity.source !== "schema") return entity;
  if (entity.compositePrimaryKey?.length || entity.compositeIndexes?.length) return entity;

  const fkColumns = entity.columns.filter(
    (column) =>
      column.refEntityId &&
      byId.get(column.refEntityId as string)?.source === "schema",
  );
  const distinctTargetIds = [...new Set(fkColumns.map((column) => column.refEntityId as string))];
  if (distinctTargetIds.length !== 2) return entity;

  const surrogatePk = entity.columns.some((column) => column.primaryKey);
  const hasPayload = entity.columns.some(
    (column) =>
      !column.primaryKey &&
      !column.refEntityId &&
      !AUDIT_COLUMNS.has(column.columnName.toLowerCase()),
  );
  // A link table carrying business columns (quantity, price, role, ...) keeps
  // its explicit shape; only indisputable pure link tables are constrained.
  if (hasPayload) return entity;

  const keyColumns = distinctTargetIds.map(
    (targetId) => fkColumns.find((column) => column.refEntityId === targetId)?.columnName as string,
  );

  if (surrogatePk) {
    const index: CompositeIndexSpec = { columns: keyColumns, unique: true, reason: "junction" };
    return { ...entity, compositeIndexes: [index] };
  }
  return { ...entity, compositePrimaryKey: keyColumns };
}

function buildLinkColumn(parent: ModelEntity): ModelColumn {
  const pkColumn = primaryKeyColumn(parent)?.columnName ?? "id";
  const columnName = `${snakeCase(singularize(parent.tableName))}_${pkColumn}`;
  return {
    name: camelCase(columnName),
    columnName,
    jsonType: "integer",
    format: "int64",
    primaryKey: false,
    nullable: false,
    unique: false,
    refEntityId: parent.id,
  };
}

/**
 * Return the input entities with explicit associative schemas annotated plus
 * synthesized, pure many-to-many link entities derived from array references.
 */
export function augmentWithJunctions(
  doc: unknown,
  entities: ModelEntity[],
): ModelEntity[] {
  const schemaEntities = entities.filter((entity) => entity.source === "schema");
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const bySchemaName = new Map(schemaEntities.map((entity) => [entity.name, entity]));
  const existingTables = new Set(entities.map((entity) => entity.tableName.toLowerCase()));

  const annotated = entities.map((entity) => annotateAssociative(entity, byId));

  if (!isObj(doc) || !isObj(doc.components) || !isObj(doc.components.schemas)) {
    return annotated;
  }
  const schemas = doc.components.schemas as AnyObj;

  const pairs = new Map<string, PairSignal>();

  for (const schemaName of Object.keys(schemas).sort()) {
    const source = bySchemaName.get(schemaName);
    if (!source) continue;
    const properties = new Map<string, unknown>();
    collectProperties(schemas[schemaName], doc as AnyObj, properties);

    for (const [propName, prop] of properties) {
      const targetName = arrayItemRefName(prop, doc as AnyObj);
      if (!targetName || targetName === schemaName) continue;
      const target = bySchemaName.get(targetName);
      if (!target) continue;
      if (!propertyNamesTargetResource(propName, target)) continue;
      // A child schema that references the parent back is a one-to-many.
      if (target.columns.some((column) => column.refEntityId === source.id)) continue;

      const [left, right] =
        source.tableName.localeCompare(target.tableName) <= 0
          ? [source, target]
          : [target, source];
      const key = `${left.tableName}::${right.tableName}`.toLowerCase();
      const signal = pairs.get(key);
      const sourcePath = `schema:${schemaName}#${propName}`;
      if (signal) {
        signal.sources.add(sourcePath);
      } else {
        pairs.set(key, { left, right, sources: new Set([sourcePath]) });
      }
    }
  }

  const junctions: ModelEntity[] = [];
  for (const signal of pairs.values()) {
    if (junctions.length >= MAX_JUNCTIONS) break;
    const linkTableName = `${signal.left.tableName}_${signal.right.tableName}`;
    if (existingTables.has(linkTableName.toLowerCase())) continue;

    const leftColumn = buildLinkColumn(signal.left);
    const rightColumn = buildLinkColumn(signal.right);
    const logicalName = `${pascalCase(singularize(signal.left.tableName))}${pascalCase(
      singularize(signal.right.tableName),
    )}`;

    junctions.push({
      id: `junction:${linkTableName}`,
      name: logicalName,
      tableName: linkTableName,
      source: "junction",
      columns: [leftColumn, rightColumn],
      compositePrimaryKey: [leftColumn.columnName, rightColumn.columnName],
      junction: {
        table: linkTableName,
        leftTable: signal.left.tableName,
        rightTable: signal.right.tableName,
        derivedFrom: [...signal.sources].sort(),
      },
    });
  }

  return [...annotated, ...junctions];
}
