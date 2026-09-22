import {
  planComponentPatch,
  type ComponentSchema,
} from "../src";
import { applyJsonPatch } from "./helpers/jsonPatch";

function schemaWith(
  properties: Record<string, unknown>,
  required: string[] = [],
): ComponentSchema {
  return {
    type: "object",
    properties: properties as ComponentSchema["properties"],
    required,
    "x-table-name": "items",
  };
}

function apply<T>(doc: T, ops: ReturnType<typeof planComponentPatch>["ops"]): T {
  return applyJsonPatch(doc, ops);
}

describe("planComponentPatch", () => {
  test("adds a brand-new schema wholesale under components.schemas", () => {
    const doc = { openapi: "3.1.0", paths: {} };
    const incoming = schemaWith({ id: { type: "integer" }, name: { type: "string" } }, ["id"]);
    const plan = planComponentPatch(doc, "Item", incoming);

    expect(plan.exists).toBe(false);
    expect(plan.addedProperties).toEqual(["id", "name"]);
    expect(plan.addedRequired).toEqual(["id"]);
    expect(plan.empty).toBe(false);

    const next = apply(doc, plan.ops);
    expect(next.components.schemas.Item.properties.id).toEqual({ type: "integer" });
    expect(next.components.schemas.Item.required).toEqual(["id"]);
  });

  test("merges into an existing schema without overwriting current properties", () => {
    const doc = {
      openapi: "3.1.0",
      components: {
        schemas: {
          Item: {
            type: "object",
            properties: { id: { type: "string", description: "kept" } },
            required: ["id"],
          },
        },
      },
    };
    // The reverse-engineered schema would change id's type; it must be ignored.
    const incoming = schemaWith(
      { id: { type: "integer" }, name: { type: "string" } },
      ["id", "name"],
    );
    const plan = planComponentPatch(doc, "Item", incoming);

    expect(plan.exists).toBe(true);
    expect(plan.addedProperties).toEqual(["name"]);
    expect(plan.skippedProperties).toEqual(["id"]);
    expect(plan.addedRequired).toEqual(["name"]);
    expect(plan.ops.some((op) => op.path.includes("id") && op.op === "add")).toBe(false);

    const next = apply(doc, plan.ops);
    // Existing property is byte-for-byte preserved.
    expect(next.components.schemas.Item.properties.id).toEqual({
      type: "string",
      description: "kept",
    });
    // New property is appended.
    expect(next.components.schemas.Item.properties.name).toEqual({ type: "string" });
    // Required is the union, current entry kept.
    expect(next.components.schemas.Item.required).toEqual(["id", "name"]);
  });

  test("reports an empty plan when every property already exists", () => {
    const doc = {
      openapi: "3.1.0",
      components: {
        schemas: {
          Item: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        },
      },
    };
    const plan = planComponentPatch(doc, "Item", schemaWith({ id: { type: "integer" } }, ["id"]));
    expect(plan.empty).toBe(true);
    expect(plan.ops).toEqual([]);
    expect(plan.skippedProperties).toEqual(["id"]);
  });

  test("creates the properties map when the object schema has none", () => {
    const doc = {
      openapi: "3.1.0",
      components: { schemas: { Item: { type: "object" } } },
    };
    const incoming = schemaWith({ id: { type: "integer" } });
    const plan = planComponentPatch(doc, "Item", incoming);
    expect(plan.addedProperties).toEqual(["id"]);
    const next = apply(doc, plan.ops);
    expect(next.components.schemas.Item.properties.id).toEqual({ type: "integer" });
  });

  test("never clobbers a non-object properties field", () => {
    const doc = {
      openapi: "3.1.0",
      components: { schemas: { Item: { type: "object", properties: "unexpected" } } },
    };
    const incoming = schemaWith({ id: { type: "integer" } });
    const plan = planComponentPatch(doc, "Item", incoming);
    expect(plan.skippedProperties).toEqual(["id"]);
    expect(plan.addedProperties).toEqual([]);
    const next = apply(doc, plan.ops);
    expect(next.components.schemas.Item.properties).toBe("unexpected");
  });
});
