import {
  buildAllDdl,
  buildIndexes,
  buildInsertStatements,
  buildMermaidErDiagram,
  buildReconciliation,
  extractEntities,
} from "../src";
import type { ModelEntity } from "../src";
import { shopDoc } from "./fixtures/shop";

function ref(name: string): Record<string, unknown> {
  return { $ref: `#/components/schemas/${name}` };
}

function doc(schemas: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: "Relations API", version: "1.0.0" },
    paths: {},
    components: { schemas },
  };
}

const userSchema = {
  type: "object",
  properties: {
    id: { type: "integer", format: "int64" },
    name: { type: "string" },
  },
};
const productSchema = {
  type: "object",
  properties: {
    id: { type: "integer", format: "int64" },
    title: { type: "string" },
  },
};

function junctionOf(entities: ModelEntity[]): ModelEntity | undefined {
  return entities.find((entity) => entity.source === "junction");
}

describe("many-to-many link table derivation (array of $ref)", () => {
  it("derives a composite-key link table from a plural array reference", () => {
    const source = doc({
      User: {
        type: "object",
        properties: {
          ...userSchema.properties,
          products: { type: "array", items: ref("Product") },
        },
        required: ["name", "products"],
      },
      Product: productSchema,
    });

    const entities = extractEntities(source);
    const link = junctionOf(entities);
    expect(link).toBeDefined();
    expect(link?.tableName).toBe("products_users");
    expect(link?.name).toBe("ProductUser");
    expect(link?.compositePrimaryKey).toEqual(["product_id", "user_id"]);
    expect(link?.columns.map((column) => column.columnName)).toEqual([
      "product_id",
      "user_id",
    ]);
    expect(link?.columns.map((column) => column.refEntityId)).toEqual([
      "schema:Product",
      "schema:User",
    ]);
    expect(link?.junction?.derivedFrom).toEqual(["schema:User#products"]);
    expect(link?.junction?.leftTable).toBe("products");
    expect(link?.junction?.rightTable).toBe("users");
  });

  it("deduplicates the two directions of the same relationship", () => {
    const source = doc({
      User: {
        type: "object",
        properties: {
          ...userSchema.properties,
          products: { type: "array", items: ref("Product") },
        },
      },
      Product: {
        type: "object",
        properties: {
          ...productSchema.properties,
          users: { type: "array", items: ref("User") },
        },
      },
    });

    const entities = extractEntities(source);
    const links = entities.filter((entity) => entity.source === "junction");
    expect(links).toHaveLength(1);
    expect(links[0].junction?.derivedFrom).toEqual([
      "schema:Product#users",
      "schema:User#products",
    ]);
  });

  it("treats a child schema that references the parent back as one-to-many", () => {
    const source = doc({
      Category: {
        type: "object",
        properties: {
          id: { type: "integer", format: "int64" },
          products: { type: "array", items: ref("Product") },
        },
      },
      Product: {
        type: "object",
        properties: {
          id: { type: "integer", format: "int64" },
          category: ref("Category"),
        },
      },
    });
    expect(junctionOf(extractEntities(source))).toBeUndefined();
  });

  it("does not treat a generic child collection name as many-to-many", () => {
    const source = doc({
      Order: {
        type: "object",
        properties: {
          id: { type: "integer", format: "int64" },
          items: { type: "array", items: ref("OrderItem") },
        },
      },
      OrderItem: {
        type: "object",
        properties: {
          id: { type: "integer", format: "int64" },
          quantity: { type: "integer" },
        },
      },
    });
    expect(junctionOf(extractEntities(source))).toBeUndefined();
  });

  it("skips self-referential arrays and arrays of primitives", () => {
    const tree = doc({
      Node: {
        type: "object",
        properties: {
          id: { type: "integer", format: "int64" },
          children: { type: "array", items: ref("Node") },
        },
      },
    });
    expect(junctionOf(extractEntities(tree))).toBeUndefined();

    const tags = doc({
      Post: {
        type: "object",
        properties: {
          id: { type: "integer", format: "int64" },
          labels: { type: "array", items: { type: "string" } },
        },
      },
    });
    expect(junctionOf(extractEntities(tags))).toBeUndefined();
  });
});

describe("explicit associative schemas", () => {
  it("gives a pure link table without a surrogate id a composite primary key", () => {
    const source = doc({
      User: userSchema,
      Product: productSchema,
      Favorite: {
        type: "object",
        properties: { user: ref("User"), product: ref("Product") },
        required: ["user", "product"],
      },
    });
    const favorite = extractEntities(source).find((e) => e.name === "Favorite");
    expect(favorite?.compositePrimaryKey).toEqual(["user", "product"]);
    expect(favorite?.compositeIndexes).toBeUndefined();

    const ddl = buildAllDdl("mysql", extractEntities(source)).sql;
    expect(ddl).toContain("PRIMARY KEY (`user`, `product`)");
    expect(ddl).toContain("FOREIGN KEY (`user`) REFERENCES `users` (`id`)");
    expect(ddl).toContain("FOREIGN KEY (`product`) REFERENCES `products` (`id`)");
  });

  it("adds a composite unique index when a pure link table keeps an id", () => {
    const source = doc({
      User: userSchema,
      Product: productSchema,
      Watch: {
        type: "object",
        properties: {
          id: { type: "integer", format: "int64" },
          user: ref("User"),
          product: ref("Product"),
        },
      },
    });
    const entities = extractEntities(source);
    const watch = entities.find((e) => e.name === "Watch");
    expect(watch?.compositePrimaryKey).toBeUndefined();
    expect(watch?.compositeIndexes).toEqual([
      { columns: ["user", "product"], unique: true, reason: "junction" },
    ]);

    const specs = buildIndexes("mysql", entities).indexes;
    const composite = specs.find((spec) => spec.columns.length === 2);
    expect(composite).toMatchObject({
      table: "watches",
      columns: ["user", "product"],
      unique: true,
      reason: "junction",
    });
    // Each foreign key still gets its own single-column index.
    expect(specs.filter((spec) => spec.columns.length === 1).map((spec) => spec.columns[0])).toEqual(
      expect.arrayContaining(["user", "product"]),
    );
  });

  it("does not constrain an associative table that carries a payload", () => {
    const source = doc({
      Order: {
        type: "object",
        properties: { id: { type: "integer", format: "int64" } },
      },
      Product: productSchema,
      OrderLine: {
        type: "object",
        properties: {
          id: { type: "integer", format: "int64" },
          order: ref("Order"),
          product: ref("Product"),
          quantity: { type: "integer" },
        },
      },
    });
    const line = extractEntities(source).find((e) => e.name === "OrderLine");
    expect(line?.compositePrimaryKey).toBeUndefined();
    expect(line?.compositeIndexes).toBeUndefined();
  });

  it("does not treat an ordinary entity with three foreign keys as a link table", () => {
    const source = doc({
      Order: { type: "object", properties: { id: { type: "integer", format: "int64" } } },
      User: userSchema,
      Product: productSchema,
      Shipment: {
        type: "object",
        properties: {
          id: { type: "integer", format: "int64" },
          order: ref("Order"),
          user: ref("User"),
          product: ref("Product"),
        },
      },
    });
    const shipment = extractEntities(source).find((e) => e.name === "Shipment");
    expect(shipment?.compositePrimaryKey).toBeUndefined();
    expect(shipment?.compositeIndexes).toBeUndefined();
  });
});

describe("derived link tables through the full pipeline", () => {
  const manyToManyDoc = doc({
    User: {
      type: "object",
      properties: {
        ...userSchema.properties,
        products: { type: "array", items: ref("Product") },
      },
    },
    Product: productSchema,
  });

  it("emits the link table last with a composite key and two foreign keys", () => {
    const entities = extractEntities(manyToManyDoc);
    const result = buildAllDdl("mysql", entities);
    const createLink = result.statements[result.statements.length - 1];
    expect(createLink).toContain("`products_users`");
    expect(createLink).toContain("PRIMARY KEY (`product_id`, `user_id`)");
    expect(createLink).toContain("FOREIGN KEY (`product_id`) REFERENCES `products` (`id`)");
    expect(createLink).toContain("FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)");
    // Parents are created before the link table.
    expect(result.sql.indexOf("`products`")).toBeLessThan(result.sql.indexOf("`products_users`"));
    expect(result.sql.indexOf("`users`")).toBeLessThan(result.sql.indexOf("`products_users`"));
  });

  it("orders the migration step after both parents and records a question", () => {
    const report = buildReconciliation({ doc: manyToManyDoc, now: () => new Date("2024-01-01T00:00:00Z") });
    const linkStep = report.migrationPlan.find((step) => step.target === "products_users");
    expect(linkStep).toBeDefined();
    expect(linkStep?.kind).toBe("create_table");
    const parentTargets = ["products", "users"];
    const parentOrders = report.migrationPlan
      .filter((step) => parentTargets.includes(step.target))
      .map((step) => step.order);
    expect(linkStep?.blockedBy.sort()).toEqual(parentOrders.sort());

    const linkTable = report.tables.find((table) => table.table === "products_users");
    expect(linkTable?.source).toBe("junction");
    expect(linkTable?.confidence).toBe("medium");
    expect(linkTable?.compositePrimaryKey).toEqual(["product_id", "user_id"]);

    expect(
      report.openQuestions.some(
        (question) => question.code === "junction_table_inferred" && question.table === "products_users",
      ),
    ).toBe(true);

    const mermaid = buildMermaidErDiagram(report);
    expect(mermaid).toMatch(/bigint product_id PK/);
    expect(mermaid).toMatch(/bigint user_id PK/);
  });

  it("skips derived link tables when generating sample rows", () => {
    const entities = extractEntities(manyToManyDoc);
    const inserts = buildInsertStatements("mysql", entities, 5);
    expect(inserts.rowCount).toBe(10); // users + products only, 5 rows each
    expect(inserts.sql).not.toContain("`products_users`");
  });
});

describe("regression: shop fixture", () => {
  it("does not derive link tables from paginated response envelopes", () => {
    const entities = extractEntities(shopDoc());
    expect(entities).toHaveLength(2);
    expect(entities.some((entity) => entity.source === "junction")).toBe(false);
  });
});
