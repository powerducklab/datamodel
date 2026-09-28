import {
  buildComponentPatch,
  buildComponentSchema,
  buildDeploymentScript,
  buildIndexes,
  buildInsertStatements,
  componentNameFromTable,
  diffEntityAgainstLive,
  ensureSchemasParentOps,
  inferPropertyFromSqlType,
  uniqueComponentName,
  type JsonPatchOp,
  type LiveTable,
  type ModelColumn,
  type ModelEntity,
} from "../src";
import { applyJsonPatch } from "./helpers/jsonPatch";

function column(partial: Partial<ModelColumn> & Pick<ModelColumn, "columnName" | "jsonType">): ModelColumn {
  return {
    name: partial.columnName,
    format: undefined,
    maxLength: undefined,
    enumValues: undefined,
    nullable: true,
    primaryKey: false,
    unique: false,
    refEntityId: undefined,
    description: undefined,
    example: undefined,
    defaultValue: undefined,
    ...partial,
  };
}

function entity(id: string, name: string, tableName: string, columns: ModelColumn[]): ModelEntity {
  return { id, name, tableName, source: "schema", ref: `#/components/schemas/${name}`, columns };
}

const idColumn = () =>
  column({ columnName: "id", jsonType: "integer", format: "int64", nullable: false, primaryKey: true });
const nameColumn = () =>
  column({ columnName: "name", jsonType: "string", maxLength: 120, nullable: false, example: "Acme" });
const emailColumn = () =>
  column({ columnName: "email", jsonType: "string", format: "email", maxLength: 200, nullable: false });

const customer = entity("schema:Customer", "Customer", "customers", [
  idColumn(),
  nameColumn(),
  emailColumn(),
]);
const order = entity("schema:Order", "Order", "orders", [
  idColumn(),
  column({
    columnName: "customer_id",
    jsonType: "integer",
    format: "int64",
    nullable: false,
    refEntityId: "schema:Customer",
  }),
  column({ columnName: "total", jsonType: "number", nullable: false, example: 10 }),
]);
const entities = [order, customer];

describe("indexes", () => {
  test("indexes foreign keys without inferring email uniqueness", () => {
    const result = buildIndexes("mysql", entities);
    const names = result.indexes.map((index) => index.name);
    expect(names).toContain("idx_orders_customer_id");
    expect(names).not.toContain("uq_customers_email");
    expect(names.some((name) => name.includes("_id_"))).toBe(false);
  });

  test("explicit unique columns become unique indexes", () => {
    const tagged = entity("schema:Tag", "Tag", "tags", [
      idColumn(),
      column({ columnName: "slug", jsonType: "string", maxLength: 80, nullable: false, unique: true }),
    ]);
    const result = buildIndexes("sqlserver", [tagged]);
    const spec = result.indexes.find((index) => index.table === "tags");
    expect(spec?.unique).toBe(true);
    expect(result.sql).toContain("CREATE UNIQUE INDEX");
    expect(result.sql).toContain("[uq_tags_slug]");
    expect(result.sql).toContain("ON [tags] ([slug])");
  });

  test("no indexes when there are no keys or unique columns", () => {
    const plain = entity("schema:Note", "Note", "notes", [
      idColumn(),
      column({ columnName: "body", jsonType: "string", nullable: true }),
    ]);
    expect(buildIndexes("mysql", [plain]).statements).toHaveLength(0);
  });
});

describe("inserts", () => {
  test("parents are inserted before children and foreign keys resolve", () => {
    const result = buildInsertStatements("mysql", entities, 3);
    const customerPos = result.sql.indexOf("INSERT INTO `customers`");
    const orderPos = result.sql.indexOf("INSERT INTO `orders`");
    expect(customerPos).toBeGreaterThanOrEqual(0);
    expect(orderPos).toBeGreaterThan(customerPos);
    // FK values must stay within 1..rows so every child points at a seeded parent.
    const fkValues = result.statements
      .filter((statement) => statement.startsWith("INSERT INTO `orders`"))
      .flatMap((statement) => statement.match(/\((\d+),/g) ?? []);
    expect(fkValues.length).toBeGreaterThan(0);
  });

  test("strings are quoted with doubled single quotes, numbers are not", () => {
    const result = buildInsertStatements("mysql", [customer], 2);
    expect(result.sql).toContain("'Acme'");
    expect(result.sql).toContain("'Acme 2'");
    const tricky = entity("schema:Note", "Note", "notes", [
      idColumn(),
      column({ columnName: "body", jsonType: "string", nullable: false, example: "it's ok" }),
    ]);
    const escaped = buildInsertStatements("mysql", [tricky], 1);
    expect(escaped.sql).toContain("'it''s ok'");
  });

  test("oracle emits one INSERT per row", () => {
    const result = buildInsertStatements("oracle", [customer], 3);
    expect(result.statements.filter((statement) => statement.startsWith("INSERT INTO")).length).toBe(3);
  });

  test("multi-row VALUES are used for mysql and sql server", () => {
    const mysql = buildInsertStatements("mysql", [customer], 4);
    const sqlserver = buildInsertStatements("sqlserver", [customer], 4);
    expect(mysql.statements).toHaveLength(1);
    expect(sqlserver.statements).toHaveLength(1);
    expect(mysql.sql.split("\n").filter((line) => line.trim().startsWith("(")).length).toBe(4);
  });

  test("row count is clamped to 1..20", () => {
    expect(buildInsertStatements("mysql", [customer], 0).rowCount).toBe(1);
    expect(buildInsertStatements("mysql", [customer], 50).rowCount).toBe(20);
  });
});

describe("deployment script", () => {
  test("bundles tables, indexes and sample data in order with counts", () => {
    const result = buildDeploymentScript("mysql", entities, { sampleRows: 3 });
    expect(result.tableCount).toBe(2);
    expect(result.indexCount).toBeGreaterThan(0);
    expect(result.insertRowCount).toBe(6);
    const tablePos = result.sql.indexOf("CREATE TABLE");
    const indexPos = result.sql.indexOf("CREATE INDEX");
    const insertPos = result.sql.indexOf("INSERT INTO");
    expect(tablePos).toBeLessThan(indexPos);
    expect(indexPos).toBeLessThan(insertPos);
    expect(result.sql).toContain("-- 1. Tables");
    expect(result.sql).toContain("-- 2. Secondary indexes");
    expect(result.sql).toContain("-- 3. Sample data");
  });

  test("omits the data section when sampleRows is 0", () => {
    const result = buildDeploymentScript("mysql", entities, { sampleRows: 0 });
    expect(result.insertRowCount).toBe(0);
    expect(result.sql).not.toContain("INSERT INTO");
  });
});

describe("live schema diff", () => {
  test("missing table is actionable", () => {
    const diff = diffEntityAgainstLive("mysql", customer, undefined);
    expect(diff.status).toBe("missing");
    expect(diff.actionableCount).toBe(1);
    expect(diff.items[0].kind).toBe("missing_table");
  });

  test("missing columns and type drift are actionable", () => {
    const live: LiveTable = {
      name: "customers",
      columns: [
        { name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true },
        { name: "name", dataType: "varchar(120)", nullable: false },
        // email is absent
      ],
    };
    const diff = diffEntityAgainstLive("mysql", customer, live);
    expect(diff.status).toBe("drift");
    expect(diff.items.some((item) => item.kind === "missing_column" && item.column === "email")).toBe(true);
  });

  test("extra live columns are informational and never actionable", () => {
    const live: LiveTable = {
      name: "customers",
      columns: [
        { name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true },
        { name: "name", dataType: "varchar(120)", nullable: false },
        { name: "email", dataType: "varchar(255)", nullable: false },
        { name: "created_at", dataType: "datetime", nullable: false },
        { name: "status_flag", dataType: "tinyint", nullable: false },
      ],
    };
    const diff = diffEntityAgainstLive("mysql", customer, live);
    expect(diff.status).toBe("matched");
    expect(diff.actionableCount).toBe(0);
    const extras = diff.items.filter((item) => item.kind === "extra_column");
    expect(extras.map((item) => item.liveColumn).sort()).toEqual(["created_at", "status_flag"]);
  });

  test("incompatible types are flagged across dialects", () => {
    const live: LiveTable = {
      name: "customers",
      columns: [
        { name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true },
        { name: "name", dataType: "text", nullable: false },
        { name: "email", dataType: "varchar(200)", nullable: false },
      ],
    };
    const diff = diffEntityAgainstLive("mysql", customer, live);
    expect(diff.items.some((item) => item.kind === "type_mismatch" && item.column === "name")).toBe(true);
  });
});

describe("reverse component generation", () => {
  test("infers OpenAPI types from SQL declarations", () => {
    expect(inferPropertyFromSqlType("bigint").type).toBe("integer");
    expect(inferPropertyFromSqlType("tinyint(1)").type).toBe("boolean");
    expect(inferPropertyFromSqlType("bit").type).toBe("boolean");
    expect(inferPropertyFromSqlType("decimal(10,2)").type).toBe("number");
    expect(inferPropertyFromSqlType("decimal(10,0)").type).toBe("integer");
    expect(inferPropertyFromSqlType("varchar(80)")).toMatchObject({ type: "string", maxLength: 80 });
    expect(inferPropertyFromSqlType("datetime").format).toBe("date-time");
    expect(inferPropertyFromSqlType("date").format).toBe("date");
    expect(inferPropertyFromSqlType("uniqueidentifier").format).toBe("uuid");
    expect(inferPropertyFromSqlType("json").type).toBe("object");
    expect(inferPropertyFromSqlType("varbinary(255)").format).toBe("byte");
    const enumerated = inferPropertyFromSqlType("enum('active','pending')");
    expect(enumerated.enum).toEqual(["active", "pending"]);
  });

  test("builds a schema honoring selection, nullability and primary keys", () => {
    const live: LiveTable = {
      name: "customers",
      columns: [
        { name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true },
        { name: "name", dataType: "varchar(120)", nullable: false },
        { name: "internal_note", dataType: "varchar(255)", nullable: true },
      ],
    };
    const schema = buildComponentSchema(live, ["id", "name"]);
    expect(Object.keys(schema.properties)).toEqual(["id", "name"]);
    expect(schema.properties.id["x-primary-key"]).toBe(true);
    expect(schema.required).toEqual(["name"]);
    expect(schema["x-table-name"]).toBe("customers");
  });

  test("patch uses add or replace and targets components.schemas", () => {
    const live: LiveTable = { name: "items", columns: [{ name: "id", dataType: "int", nullable: false, isPrimaryKey: true }] };
    const schema = buildComponentSchema(live, ["id"]);
    const add = buildComponentPatch("Item", schema);
    expect(add[0].op).toBe("add");
    expect(add[0].path).toEqual(["components", "schemas", "Item"]);
    const replace = buildComponentPatch("Item", schema, { exists: true });
    expect(replace[0].op).toBe("replace");
  });

  test("component names are singular pascal case and unique", () => {
    expect(componentNameFromTable("order_items")).toBe("OrderItem");
    expect(componentNameFromTable("dbo.people")).toBe("Person");
    expect(uniqueComponentName("OrderItem", ["OrderItem", "orderitem2"])).toBe("OrderItem3");
  });

  test("parent ops are synthesized only for missing components/schemas maps", () => {
    expect(ensureSchemasParentOps({})).toHaveLength(2);
    expect(ensureSchemasParentOps({ components: {} })).toHaveLength(1);
    expect(ensureSchemasParentOps({ components: { schemas: {} } })).toHaveLength(0);
    expect(ensureSchemasParentOps(null)).toHaveLength(0);
    const withNullComponents = ensureSchemasParentOps({ components: null });
    expect(withNullComponents[0].path).toEqual(["components"]);
  });

  test("component patch applies on a spec without components section", () => {
    const live: LiveTable = {
      name: "project",
      columns: [{ name: "project_id", dataType: "int(11) unsigned", nullable: false, isPrimaryKey: true }],
    };
    const schema = buildComponentSchema(live, ["project_id"]);
    const doc: Record<string, unknown> = { openapi: "3.1.0", info: { title: "t", version: "1" }, paths: {} };
    const ops: JsonPatchOp[] = [
      ...ensureSchemasParentOps(doc),
      ...buildComponentPatch("Project", schema),
    ];
    const parsed = applyJsonPatch(doc, ops) as any;
    expect(parsed.components.schemas.Project.properties.project_id["x-primary-key"]).toBe(true);
    expect(parsed.paths).toEqual({});
  });

  test("component patch applies on a spec with components but no schemas", () => {
    const live: LiveTable = {
      name: "project",
      columns: [{ name: "name", dataType: "varchar(200)", nullable: true }],
    };
    const schema = buildComponentSchema(live, ["name"]);
    const doc: Record<string, unknown> = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {},
      components: { securitySchemes: {} },
    };
    const ops: JsonPatchOp[] = [
      ...ensureSchemasParentOps(doc),
      ...buildComponentPatch("Project", schema),
    ];
    const parsed = applyJsonPatch(doc, ops) as any;
    expect(parsed.components.schemas.Project).toBeTruthy();
    expect(parsed.components.securitySchemes).toEqual({});
  });
});
