import {
  buildAllDdl,
  buildAlterScript,
  buildSampleData,
  buildTableDdl,
  DIALECTS,
  extractEntities,
  pluralize,
  snakeCase,
  tableNameFor,
} from "../src";

const doc = {
  openapi: "3.1.0",
  info: { title: "Shop", version: "1.0.0" },
  paths: {
    "/orders": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["customerEmail"],
                properties: {
                  customerEmail: { type: "string", format: "email" },
                  items: {
                    type: "array",
                    items: { $ref: "#/components/schemas/OrderItem" },
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Order" },
              },
            },
          },
        },
      },
      get: {
        responses: {
          "200": {
            description: "list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Order" },
                    },
                    total: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Category: {
        type: "object",
        "x-table-name": "catalog_categories",
        properties: {
          id: { type: "integer", format: "int64" },
          name: { type: "string", maxLength: 80 },
        },
        required: ["id", "name"],
      },
      OrderItem: {
        type: "object",
        properties: {
          sku: { type: "string" },
          quantity: { type: "integer" },
        },
        required: ["sku"],
      },
      Order: {
        allOf: [
          { $ref: "#/components/schemas/Audit" },
          {
            type: "object",
            required: ["id", "status"],
            properties: {
              id: { type: "string", format: "uuid" },
              status: { type: "string", enum: ["new", "paid", "shipped"] },
              placedAt: { type: "string", format: "date-time" },
              category: { $ref: "#/components/schemas/Category" },
              note: { type: "string", nullable: true },
            },
          },
        ],
      },
      Audit: {
        type: "object",
        properties: {
          createdAt: { type: "string", format: "date-time" },
        },
      },
      Tags: { type: "array", items: { type: "string" } },
    },
  },
};

test("naming helpers convert, pluralize, and snake-case identifiers", () => {
  expect(snakeCase("createdAt")).toBe("created_at");
  expect(snakeCase("OrderItem")).toBe("order_item");
  expect(pluralize("Category")).toBe("Categories");
  expect(pluralize("OrderItem")).toBe("OrderItems");
  expect(pluralize("Box")).toBe("Boxes");
  expect(pluralize("child")).toBe("children");
  expect(tableNameFor("OrderItem")).toBe("order_items");
});

test("extracts schema entities, flattens allOf, marks FKs, and skips arrays", () => {
  const entities = extractEntities(doc);
  const ids = entities.map((e) => e.id);
  expect(ids).toContain("schema:Order");
  expect(ids).toContain("schema:Category");
  expect(ids).not.toContain("schema:Tags");

  const order = entities.find((e) => e.id === "schema:Order")!;
  const names = order.columns.map((c) => c.columnName);
  expect(names).toEqual(
    expect.arrayContaining(["created_at", "id", "status", "placed_at", "category", "note"]),
  );
  const categoryCol = order.columns.find((c) => c.name === "category")!;
  expect(categoryCol.refEntityId).toBe("schema:Category");
  expect(categoryCol.jsonType).toBe("integer");
  expect(categoryCol.nullable).toBe(true);

  const id = order.columns.find((c) => c.name === "id")!;
  expect(id.primaryKey).toBe(true);
  expect(id.nullable).toBe(false);
  const status = order.columns.find((c) => c.name === "status")!;
  expect(status.nullable).toBe(false);
  expect(status.enumValues).toEqual(["new", "paid", "shipped"]);
  const note = order.columns.find((c) => c.name === "note")!;
  expect(note.nullable).toBe(true);

  const category = entities.find((e) => e.id === "schema:Category")!;
  expect(category.tableName).toBe("catalog_categories");
});

test("extracts inline request bodies but skips envelopes and referenced responses", () => {
  const entities = extractEntities(doc);
  const request = entities.find((e) => e.id === "request:POST /orders");
  expect(request).toBeTruthy();
  expect(request?.name).toBe("CreateOrderRequest");
  const email = request!.columns.find((c) => c.name === "customerEmail");
  expect(email?.nullable).toBe(false);
  // Array of $ref becomes a JSON column, not a join table.
  const items = request!.columns.find((c) => c.name === "items");
  expect(items?.jsonType).toBe("array");
  // The GET /orders envelope is not turned into an entity.
  expect(entities.some((e) => e.id.startsWith("response:GET /orders"))).toBe(false);
  // The 201 response is a $ref, so no response entity either.
  expect(entities.some((e) => e.id.startsWith("response:POST /orders"))).toBe(false);
});

test("dialect type mapping covers the key JSON Schema types", () => {
  const col = (over: Record<string, unknown>) =>
    ({
      name: "x",
      columnName: "x",
      jsonType: "string",
      primaryKey: false,
      nullable: true,
      unique: false,
      ...over,
    }) as any;
  const mysql = DIALECTS.mysql;
  const sqlserver = DIALECTS.sqlserver;
  const oracle = DIALECTS.oracle;

  expect(mysql.columnType(col({ jsonType: "boolean" }))).toBe("TINYINT(1)");
  expect(sqlserver.columnType(col({ jsonType: "boolean" }))).toBe("BIT");
  expect(oracle.columnType(col({ jsonType: "boolean" }))).toBe("NUMBER(1)");

  expect(mysql.columnType(col({ maxLength: 80 }))).toBe("VARCHAR(80)");
  expect(sqlserver.columnType(col({ maxLength: 80 }))).toBe("NVARCHAR(80)");
  expect(oracle.columnType(col({ maxLength: 80 }))).toBe("VARCHAR2(80 CHAR)");

  expect(mysql.columnType(col({ format: "uuid" }))).toBe("CHAR(36)");
  expect(sqlserver.columnType(col({ format: "uuid" }))).toBe("UNIQUEIDENTIFIER");
  expect(oracle.columnType(col({ format: "uuid" }))).toBe("CHAR(36 CHAR)");

  expect(mysql.columnType(col({ format: "date-time" }))).toBe("DATETIME(6)");
  expect(sqlserver.columnType(col({ format: "date-time" }))).toBe("DATETIME2");
  expect(oracle.columnType(col({ format: "date-time" }))).toBe("TIMESTAMP(6)");

  expect(mysql.columnType(col({ enumValues: ["new", "paid"] }))).toBe(
    "ENUM('new', 'paid')",
  );
  expect(
    mysql.columnType(col({ jsonType: "integer", format: "int64", refEntityId: "schema:X" })),
  ).toBe("BIGINT");
  expect(mysql.columnType(col({ jsonType: "object" }))).toBe("JSON");
  expect(sqlserver.columnType(col({ jsonType: "object" }))).toBe("NVARCHAR(MAX)");
  expect(oracle.columnType(col({ jsonType: "object" }))).toBe("CLOB");
});

test("generates quoted CREATE TABLE statements with identity PK and ordered FKs", () => {
  const entities = extractEntities(doc);
  const mysql = buildAllDdl("mysql", entities);
  const statements = mysql.statements;
  // Category (referenced by Order) is created before Order.
  const categoryIndex = statements.findIndex((s) => s.includes("`catalog_categories`"));
  const orderIndex = statements.findIndex((s) => s.includes("CREATE TABLE IF NOT EXISTS `orders`"));
  expect(categoryIndex).toBeGreaterThanOrEqual(0);
  expect(orderIndex).toBeGreaterThan(categoryIndex);

  const orderDdl = statements[orderIndex];
  expect(orderDdl).toContain("`id` CHAR(36) NOT NULL");
  expect(orderDdl).toContain("PRIMARY KEY (`id`)");
  expect(orderDdl).toMatch(/FOREIGN KEY \(`category`\) REFERENCES `catalog_categories`/);

  const categoryDdl = statements[categoryIndex];
  expect(categoryDdl).toContain("`id` BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY");

  const sqlserver = buildTableDdl("sqlserver", entities.find((e) => e.id === "schema:Category")!, entities);
  expect(sqlserver).toContain("[id] BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY");

  const oracle = buildTableDdl("oracle", entities.find((e) => e.id === "schema:Category")!, entities);
  expect(oracle).toContain('"id" NUMBER(19) GENERATED BY DEFAULT AS IDENTITY NOT NULL PRIMARY KEY');
});

test("alter scripts create missing tables and add or modify columns", () => {
  const entities = extractEntities(doc);
  const category = entities.find((e) => e.id === "schema:Category")!;

  const created = buildAlterScript("mysql", category, undefined, entities);
  expect(created[0]).toContain("CREATE TABLE");

  const live = {
    name: "catalog_categories",
    columns: [
      { name: "id", dataType: "bigint" },
      { name: "name", dataType: "varchar(50)" },
    ],
  };
  const altered = buildAlterScript("mysql", category, live, entities);
  // varchar(50) vs varchar(80) -> modify; nothing missing.
  expect(altered).toHaveLength(1);
  expect(altered[0]).toContain("MODIFY COLUMN");

  const partial = { name: "catalog_categories", columns: [{ name: "id", dataType: "bigint" }] };
  const added = buildAlterScript("sqlserver", category, partial, entities);
  expect(added[0]).toContain("REVIEW ONLY");
  expect(added[0]).toContain("ADD [name]");
  expect(added[0]).not.toContain("ADD COLUMN");
});

test("sample data is deterministic and grounded in schema constraints", () => {
  const entities = extractEntities(doc);
  const order = entities.find((e) => e.id === "schema:Order")!;
  const sample = buildSampleData(order, 3);
  expect(sample.rows).toHaveLength(3);
  const colIndex = Object.fromEntries(sample.columns.map((c, i) => [c.key, i]));
  const statusValues = sample.rows.map((r) => r[colIndex.status]);
  expect(statusValues).toEqual(["new", "paid", "shipped"]);
  const idValues = sample.rows.map((r) => r[colIndex.id]);
  expect(idValues[0]).toMatch(/^00000000-0000-4000-/);
  const categoryValues = sample.rows.map((r) => r[colIndex.category]);
  expect(categoryValues).toEqual([3, 4, 5]);
  // Regeneration yields identical rows.
  expect(buildSampleData(order, 3).rows).toEqual(sample.rows);
});
