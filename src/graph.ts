import type {
  DialectId,
  LiveColumn,
  LiveForeignKey,
  LiveTable,
  ModelColumn,
  ModelEntity,
} from "./types";
import { diffEntityAgainstLive, type DiffItem, type DiffStatus } from "./diff";
import { resolveTableName, type TableNameOverrides } from "./ddl";

/**
 * Unified entity-relationship graph.
 *
 * The graph merges two fact sources into one node/edge model:
 *   - modeled tables and object-reference foreign keys derived from OpenAPI;
 *   - live tables and enforced foreign keys observed through read-only
 *     database introspection.
 *
 * Every node is classified as:
 *   - missing: modeled only, the table does not exist in the live database
 *     (a brand-new table, rendered green in the UI);
 *   - drift:   present on both sides but columns/types differ (yellow);
 *   - matched: present and compatible on both sides (neutral);
 *   - extra:   live only, the database table is not represented in the API
 *     model (an orphan table, rendered grey).
 *
 * The graph is computed deterministically. It never invents relationships:
 * edges only come from explicit OpenAPI object references or real database
 * foreign-key constraints, so the default confidence is always "high". The
 * confidence field exists so future, convention-based heuristics can report
 * "medium"/"low" without changing the contract.
 */

export type GraphNodeStatus = DiffStatus | "extra";
export type RelationshipOrigin = "model" | "live" | "both";
export type RelationshipConfidence = "high" | "medium" | "low";

export interface GraphNode {
  /** Stable identity: the physical table name, lower-cased, schema stripped. */
  id: string;
  /** Physical table name used for display and SQL. */
  table: string;
  /** Logical entity name for modeled tables. */
  logicalName?: string;
  /** Model entity id for modeled tables ("schema:Product"). */
  entityId?: string;
  /** Entity provenance for modeled tables. */
  source?: ModelEntity["source"];
  status: GraphNodeStatus;
  /** True when the OpenAPI model defines this table. */
  modeled: boolean;
  /** True when the live database contains this table. */
  live: boolean;
  modeledColumns: ModelColumn[];
  liveColumns: LiveColumn[];
  /** Structured model-vs-live differences; empty for live-only or matched nodes. */
  diffs: DiffItem[];
}

export interface GraphRelationship {
  /** Stable identity: child table/column -> parent table. */
  id: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  /** Where the edge was observed. */
  origin: RelationshipOrigin;
  confidence: RelationshipConfidence;
  /** True when a real database constraint enforces the edge. */
  enforced: boolean;
  /** Model entity id of the child table, when the edge came from the model. */
  childEntityId?: string;
}

export interface ErGraph {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  summary: {
    tables: number;
    relationships: number;
    matched: number;
    drift: number;
    missing: number;
    extra: number;
  };
}

export interface BuildGraphOptions {
  dialectId?: DialectId;
  liveTables?: LiveTable[];
  liveForeignKeys?: LiveForeignKey[];
  overrides?: TableNameOverrides;
}

/**
 * Normalize a possibly schema-qualified physical table name to a stable key:
 * schema/owner prefix and quoting are stripped, the result is lower-cased.
 * "dbo.Orders" and "orders" therefore collide intentionally.
 */
export function tableKey(name: string): string {
  const segment = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return segment.replace(/[`"\[\]]/g, "").trim().toLowerCase();
}

function edgeKey(fromTable: string, fromColumn: string, toTable: string): string {
  return `${tableKey(fromTable)}::${fromColumn.trim().toLowerCase()}->${tableKey(toTable)}`;
}

function primaryKeyColumn(entity: ModelEntity): ModelColumn | undefined {
  return entity.columns.find((column) => column.primaryKey);
}

function qualifiedLiveName(table: LiveTable): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

/**
 * Merge modeled entities and optional live database evidence into one graph.
 * With no `liveTables` argument every modeled node is "missing" (forward-only
 * planning for a database that has not been created yet).
 */
export function buildGraph(
  entities: ModelEntity[],
  options: BuildGraphOptions = {},
): ErGraph {
  const dialectId: DialectId = options.dialectId ?? "mysql";
  const liveTables = options.liveTables ?? [];
  const liveForeignKeys = options.liveForeignKeys ?? [];
  const hasLive = Array.isArray(options.liveTables);

  const liveByKey = new Map<string, LiveTable>();
  for (const table of liveTables) {
    const key = tableKey(qualifiedLiveName(table));
    if (!liveByKey.has(key)) liveByKey.set(key, table);
  }

  const modeledKeys = new Set<string>();
  const nodes: GraphNode[] = [];

  for (const entity of entities) {
    const physical = resolveTableName(entity, options.overrides);
    const key = tableKey(physical);
    modeledKeys.add(key);
    const live = liveByKey.get(key);

    let status: GraphNodeStatus = "missing";
    let diffs: DiffItem[] = [];
    if (hasLive) {
      if (!live) {
        status = "missing";
      } else {
        const diff = diffEntityAgainstLive(dialectId, entity, live, options.overrides);
        status = diff.status;
        diffs = diff.items;
      }
    }

    nodes.push({
      id: key,
      table: physical,
      logicalName: entity.name,
      entityId: entity.id,
      source: entity.source,
      status,
      modeled: true,
      live: Boolean(live),
      modeledColumns: entity.columns,
      liveColumns: live?.columns ?? [],
      diffs,
    });
  }

  for (const table of liveTables) {
    const physical = qualifiedLiveName(table);
    const key = tableKey(physical);
    if (modeledKeys.has(key)) continue;
    modeledKeys.add(key);
    nodes.push({
      id: key,
      table: physical,
      status: "extra",
      modeled: false,
      live: true,
      modeledColumns: [],
      liveColumns: table.columns,
      diffs: [],
    });
  }

  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
  const relationships = new Map<string, GraphRelationship>();

  for (const entity of entities) {
    const fromTable = resolveTableName(entity, options.overrides);
    for (const column of entity.columns) {
      if (!column.refEntityId) continue;
      const target = entitiesById.get(column.refEntityId);
      if (!target) continue;
      const toTable = resolveTableName(target, options.overrides);
      const toColumn = primaryKeyColumn(target)?.columnName ?? "id";
      relationships.set(
        edgeKey(fromTable, column.columnName, toTable),
        {
          id: edgeKey(fromTable, column.columnName, toTable),
          fromTable,
          fromColumn: column.columnName,
          toTable,
          toColumn,
          origin: "model",
          // Edges inside a link table derived from an array-of-$ref are an
          // explicit reference under a conventional join-table shape; they are
          // surfaced as medium confidence for the user to confirm.
          confidence: entity.source === "junction" ? "medium" : "high",
          enforced: false,
          childEntityId: entity.id,
        },
      );
    }
  }

  for (const fk of liveForeignKeys) {
    const key = edgeKey(fk.table, fk.column, fk.refTable);
    const existing = relationships.get(key);
    if (existing) {
      existing.origin = "both";
      existing.enforced = true;
      existing.confidence = "high";
    } else {
      relationships.set(key, {
        id: key,
        fromTable: fk.table,
        fromColumn: fk.column,
        toTable: fk.refTable,
        toColumn: fk.refColumn,
        origin: "live",
        confidence: "high",
        enforced: true,
      });
    }
  }

  const relationshipList = [...relationships.values()];
  const summary = {
    tables: nodes.length,
    relationships: relationshipList.length,
    matched: nodes.filter((node) => node.status === "matched").length,
    drift: nodes.filter((node) => node.status === "drift").length,
    missing: nodes.filter((node) => node.status === "missing").length,
    extra: nodes.filter((node) => node.status === "extra").length,
  };

  return { nodes, relationships: relationshipList, summary };
}
