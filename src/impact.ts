import type { ModelEntity } from "./types";

/**
 * Operation-to-schema impact index.
 *
 * The forward pipeline (OpenAPI -> tables) already knows which tables a schema
 * implies. Change-impact analysis needs the reverse direction too: when a table
 * or component schema changes, which API operations are affected? This module
 * scans every operation and records the reusable schemas referenced from its
 * request body, responses and parameters.
 *
 * Only explicit `$ref` targets under components/schemas are collected; the
 * index never guesses implicit relationships.
 */

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
const MAX_TRAVERSAL_DEPTH = 32;
const SCHEMA_REF_PREFIX = "#/components/schemas/";

type AnyObj = Record<string, unknown>;
type RefResolver = (name: string) => unknown;

export type UsageLocation = "request" | "response" | "parameter";

export interface OperationUsage {
  /** Operation reference, e.g. "POST /orders". */
  ref: string;
  method: string;
  path: string;
  location: UsageLocation;
  /** HTTP status code for response usages ("200"). */
  statusCode?: string;
  /** Referenced component schema name. */
  schema: string;
}

export interface ImpactIndex {
  /** Schema name -> every operation that references it. */
  schemaUsages: Record<string, OperationUsage[]>;
  /** Every operation reference declared in the document. */
  operations: string[];
}

function isObj(value: unknown): value is AnyObj {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function refName(ref: unknown): string | undefined {
  if (typeof ref !== "string" || !ref.startsWith(SCHEMA_REF_PREFIX)) return undefined;
  const name = ref.slice(SCHEMA_REF_PREFIX.length);
  return name ? name.replace(/~1/g, "/").replace(/~0/g, "~") : undefined;
}

/**
 * Collect every component schema reference reachable from one root schema,
 * following `$ref` into components.schemas so the result is a transitive set
 * (an operation returning Order also depends on Order's nested Customer).
 *
 * A fresh `seen` set is used per root so each operation is indexed independently;
 * it also terminates reference cycles. Depth guards against pathological docs.
 */
function collectRootRefs(
  rootSchema: unknown,
  resolve: RefResolver,
  onRef: (name: string) => void,
): void {
  const seen = new Set<string>();

  const walk = (value: unknown, depth: number): void => {
    if (!isObj(value) || depth > MAX_TRAVERSAL_DEPTH) return;
    const direct = refName(value.$ref);
    if (direct) {
      onRef(direct);
      if (!seen.has(direct)) {
        seen.add(direct);
        walk(resolve(direct), depth + 1);
      }
      return;
    }
    for (const nested of Object.values(value)) {
      if (Array.isArray(nested)) {
        for (const item of nested) walk(item, depth + 1);
      } else {
        walk(nested, depth + 1);
      }
    }
  };

  walk(rootSchema, 0);
}

function addUsage(
  bucket: Map<string, OperationUsage[]>,
  seen: Set<string>,
  usage: OperationUsage,
): void {
  const dedupeKey = `${usage.ref}|${usage.location}|${usage.statusCode ?? ""}|${usage.schema}`;
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  const list = bucket.get(usage.schema) ?? [];
  list.push(usage);
  bucket.set(usage.schema, list);
}

/** Build the reverse index of component-schema usage across operations. */
export function buildImpactIndex(doc: unknown): ImpactIndex {
  const bucket = new Map<string, OperationUsage[]>();
  const seen = new Set<string>();
  const operations: string[] = [];

  if (!isObj(doc) || !isObj(doc.paths)) {
    return { schemaUsages: {}, operations: [] };
  }

  const components = isObj(doc.components) ? doc.components : undefined;
  const componentSchemas = isObj(components?.schemas)
    ? (components!.schemas as Record<string, unknown>)
    : {};
  const resolve: RefResolver = (name) => componentSchemas[name];

  for (const [path, pathItemRaw] of Object.entries(doc.paths)) {
    const pathItem = pathItemRaw;
    if (!isObj(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isObj(operation)) continue;
      const ref = `${method.toUpperCase()} ${path}`;
      operations.push(ref);

      const requestSchema =
        operation.requestBody && isObj(operation.requestBody)
          ? (operation.requestBody as AnyObj)?.content
          : undefined;
      if (isObj(requestSchema)) {
        for (const media of Object.values(requestSchema)) {
          const schema = isObj(media) ? (media as AnyObj).schema : undefined;
          if (schema) {
            collectRootRefs(schema, resolve, (name) =>
              addUsage(bucket, seen, { ref, method, path, location: "request", schema: name }),
            );
          }
        }
      }

      if (isObj(operation.responses)) {
        for (const [statusCode, responseRaw] of Object.entries(operation.responses)) {
          const content = isObj(responseRaw) ? (responseRaw as AnyObj).content : undefined;
          if (!isObj(content)) continue;
          for (const media of Object.values(content)) {
            const schema = isObj(media) ? (media as AnyObj).schema : undefined;
            if (schema) {
              collectRootRefs(schema, resolve, (name) =>
                addUsage(bucket, seen, {
                  ref,
                  method,
                  path,
                  location: "response",
                  statusCode,
                  schema: name,
                }),
              );
            }
          }
        }
      }

      if (Array.isArray(operation.parameters)) {
        for (const parameterRaw of operation.parameters) {
          const parameter = parameterRaw;
          if (!isObj(parameter)) continue;
          if (parameter.schema) {
            collectRootRefs(parameter.schema, resolve, (name) =>
              addUsage(bucket, seen, { ref, method, path, location: "parameter", schema: name }),
            );
          }
        }
      }
    }
  }

  const schemaUsages: Record<string, OperationUsage[]> = {};
  for (const [name, usages] of bucket) {
    schemaUsages[name] = usages.sort((a, b) => a.ref.localeCompare(b.ref));
  }
  operations.sort();
  return { schemaUsages, operations };
}

/**
 * Return the distinct operations affected by one modeled entity.
 *
 * Reusable component entities map through the reverse index; inline
 * request/response entities carry their owning operation reference directly.
 */
export function operationsForEntity(
  entity: ModelEntity,
  index: ImpactIndex,
): string[] {
  const refs = new Set<string>();

  if (entity.source === "schema") {
    for (const usage of index.schemaUsages[entity.name] ?? []) refs.add(usage.ref);
  }
  if (entity.ref) refs.add(entity.ref);

  return [...refs].sort();
}
