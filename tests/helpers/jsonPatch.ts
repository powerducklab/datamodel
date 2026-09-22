/**
 * Minimal RFC 6902 JSON Patch applier used only by the test suite.
 *
 * The published package has zero runtime dependencies; reverse-engineering
 * tests need to apply the JsonPatchOp[] produced by the library without pulling
 * in @powerduck/conf-patch or a YAML toolkit. This implements exactly the
 * operations the library emits (add/replace on object maps, append via "-" and
 * numeric indices on arrays, plus remove for completeness).
 */

export type JsonPatchOpLike = {
  op: "add" | "replace" | "remove";
  path: (string | number)[];
  value?: unknown;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function navigate(target: unknown, segments: string[]): unknown {
  let current: unknown = target;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new Error(`Cannot navigate path segment "${segment}"`);
    }
  }
  return current;
}

/** Apply a sequence of JSON Patch ops to a deep-cloned JSON document. */
export function applyJsonPatch<T>(input: T, ops: JsonPatchOpLike[]): T {
  const doc = clone(input) as unknown;
  for (const op of ops) {
    const path = op.path.map((segment) => String(segment));
    if (path.length === 0) {
      throw new Error("Replacing the document root is not supported in tests");
    }
    const key = path[path.length - 1];
    const parent = navigate(doc, path.slice(0, -1));

    if (Array.isArray(parent)) {
      const index = key === "-" ? parent.length : Number(key);
      if (op.op === "remove") {
        parent.splice(index, 1);
      } else if (key === "-" || index >= parent.length) {
        parent.push(op.value);
      } else {
        parent.splice(index, op.op === "replace" ? 1 : 0, op.value);
      }
    } else if (parent && typeof parent === "object") {
      const map = parent as Record<string, unknown>;
      if (op.op === "remove") delete map[key];
      else map[key] = op.value;
    } else {
      throw new Error(`Patch target parent is not an object or array for "${key}"`);
    }
  }
  return doc as T;
}
