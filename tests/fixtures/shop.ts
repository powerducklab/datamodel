import type { LiveForeignKey, LiveTable } from "../../src";

/**
 * Shared, fact-checked fixture for the graph/impact/reconciliation/exporter
 * suites. The modeled schema and the live table definitions below match the
 * exact DDL the library generates, so a "matched" reconciliation is genuinely
 * compatible rather than optimistically assumed.
 *
 * Foreign keys are modeled the way extractEntities understands them: an object
 * property whose value is a component $ref becomes an integer FK column named
 * after the property (`Order.customer` -> column `customer` -> customers(id)).
 */
export function shopDoc(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: "Shop API", version: "1.0.0" },
    paths: {
      "/customers": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: { type: "array", items: { $ref: "#/components/schemas/Customer" } },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Customer" } } },
          },
          responses: { "201": { description: "created" } },
        },
      },
      "/customers/{id}": {
        get: {
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "integer", format: "int64" } },
          ],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Customer" } },
              },
            },
          },
        },
      },
      "/orders": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: { type: "array", items: { $ref: "#/components/schemas/Order" } },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } },
          },
          responses: { "201": { description: "created" } },
        },
      },
    },
    components: {
      schemas: {
        Customer: {
          type: "object",
          properties: {
            id: { type: "integer", format: "int64" },
            name: { type: "string", maxLength: 100 },
            email: { type: "string", format: "email" },
          },
          required: ["name", "email"],
        },
        Order: {
          type: "object",
          properties: {
            id: { type: "integer", format: "int64" },
            customer: { $ref: "#/components/schemas/Customer" },
            total: { type: "number", format: "decimal" },
            status: { type: "string", maxLength: 20 },
          },
          required: ["customer", "total", "status"],
        },
      },
    },
  };
}

/** A live `customers` table whose columns/types match the generated model. */
export function liveCustomers(): LiveTable {
  return {
    name: "customers",
    columns: [
      { name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true },
      { name: "name", dataType: "varchar(100)", nullable: false },
      { name: "email", dataType: "varchar(255)", nullable: false },
    ],
  };
}

/** A live `orders` table; pass includeTotal=false to induce a drift diff. */
export function liveOrders(includeTotal = true): LiveTable {
  const columns = [
    { name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true },
    { name: "customer", dataType: "bigint", nullable: false },
    ...(includeTotal ? [{ name: "total", dataType: "decimal(18,4)", nullable: false }] : []),
    { name: "status", dataType: "varchar(20)", nullable: false },
  ];
  return { name: "orders", columns: columns as LiveTable["columns"] };
}

/** The enforced orders.customer -> customers.id foreign key. */
export function orderFk(): LiveForeignKey {
  return { table: "orders", column: "customer", refTable: "customers", refColumn: "id" };
}
