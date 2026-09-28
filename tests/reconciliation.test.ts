import {
  buildReconciliation,
  RECONCILIATION_SCHEMA_VERSION,
  type BuildReconciliationOptions,
  type DataModelReconciliation,
} from "../src/reconciliation";
import type { LiveTable } from "../src";
import { shopDoc, liveCustomers, liveOrders, orderFk } from "./fixtures/shop";

const FIXED_NOW = "2024-06-01T00:00:00.000Z";

function reconcile(
  overrides: Partial<BuildReconciliationOptions> = {},
): DataModelReconciliation {
  return buildReconciliation({
    doc: shopDoc(),
    dialectId: "mysql",
    now: () => new Date(FIXED_NOW),
    specDigest: "sha256:abc",
    ...overrides,
  });
}

describe("buildReconciliation — spec-only (forward engineering)", () => {
  it("reports the schema version, a fixed timestamp and the dialect", () => {
    const report = reconcile();
    expect(report.schemaVersion).toBe(RECONCILIATION_SCHEMA_VERSION);
    expect(report.generatedAt).toBe(FIXED_NOW);
    expect(report.dialect).toBe("mysql");
  });

  it("describes the spec and a disconnected database", () => {
    const report = reconcile();
    expect(report.source.spec).toMatchObject({
      title: "Shop API",
      version: "1.0.0",
      digest: "sha256:abc",
      operationCount: 5,
    });
    expect(report.source.database).toMatchObject({
      connected: false,
      tableCount: 0,
      dialect: "mysql",
    });
  });

  it("marks every modeled table missing and raises the no-live-database question", () => {
    const report = reconcile();
    expect(report.summary).toMatchObject({
      modeledTables: 2,
      liveTables: 0,
      missing: 2,
      matched: 0,
      drift: 0,
      extra: 0,
    });
    expect(report.openQuestions.some((question) => question.code === "no_live_database")).toBe(true);
  });

  it("orders CREATE steps by foreign-key dependency", () => {
    const report = reconcile();
    const creates = report.migrationPlan.filter((step) => step.kind === "create_table");
    expect(creates).toHaveLength(2);
    expect(creates[0].target).toBe("customers");
    expect(creates[0].order).toBe(1);
    expect(creates[0].blockedBy).toEqual([]);
    expect(creates[1].target).toBe("orders");
    expect(creates[1].order).toBe(2);
    expect(creates[1].blockedBy).toEqual([1]);
  });

  it("emits additive CREATE SQL with the foreign key but never DROP/DELETE", () => {
    const report = reconcile();
    const orders = report.tables.find((table) => table.table === "orders");
    const createSql = orders?.proposedSql.createStatements.join("\n") ?? "";
    expect(createSql).toContain("CREATE TABLE");
    expect(createSql).toMatch(/FOREIGN KEY \(`customer`\) REFERENCES `customers`/);
    const allSql = report.migrationPlan.map((step) => step.sql.join("\n")).join("\n");
    expect(allSql).not.toMatch(/DROP/i);
    expect(allSql).not.toMatch(/DELETE/i);
  });

  it("links each table to the operations that reference it", () => {
    const report = reconcile();
    const order = report.tables.find((table) => table.logicalName === "Order");
    expect(order?.impactedOperations).toEqual(["GET /orders", "POST /orders"]);
    const customer = report.tables.find((table) => table.logicalName === "Customer");
    expect(customer?.impactedOperations).toContain("POST /orders");
    expect(customer?.impactedOperations).toContain("GET /customers/{id}");
  });

  it("exposes modeled column pairs without live evidence", () => {
    const report = reconcile();
    const customer = report.tables.find((table) => table.logicalName === "Customer");
    const email = customer?.columns.find((column) => column.name === "email");
    expect(email?.modeled).toBeDefined();
    expect(email?.live).toBeUndefined();
  });

  it("always includes safeguards", () => {
    const report = reconcile();
    expect(report.safeguards.length).toBeGreaterThanOrEqual(4);
    expect(report.safeguards.join(" ")).toMatch(/never executes/i);
  });
});

describe("buildReconciliation — live database", () => {
  it("reports matched tables and review-only index proposals without catalog evidence", () => {
    const report = reconcile({
      liveTables: [liveCustomers(), liveOrders()],
      liveForeignKeys: [orderFk()],
      database: { name: "prod", host: "10.0.0.1", database: "shop" },
    });
    expect(report.source.database).toMatchObject({
      connected: true,
      tableCount: 2,
      name: "prod",
      host: "10.0.0.1",
      database: "shop",
    });
    expect(report.summary).toMatchObject({
      matched: 2,
      missing: 0,
      drift: 0,
      extra: 0,
    });
    expect(report.summary.enforcedRelationships).toBe(1);
    expect(report.summary.unenforcedRelationships).toBe(0);
    expect(report.migrationPlan.every(step => step.requiresReview && step.sql.every(sql => sql.startsWith("-- REVIEW ONLY")))).toBe(true);
    expect(report.openQuestions).toEqual([]);
  });

  it("flags a modeled relationship that is not enforced in the live database", () => {
    const report = reconcile({ liveTables: [liveCustomers(), liveOrders()] });
    expect(report.summary.enforcedRelationships).toBe(0);
    expect(report.summary.unenforcedRelationships).toBe(1);
    expect(report.openQuestions.some((question) => question.code === "relationship_not_enforced")).toBe(true);
  });

  it("produces an additive ALTER step for a drifting table", () => {
    const report = reconcile({
      liveTables: [liveCustomers(), liveOrders(false)],
      liveForeignKeys: [orderFk()],
    });
    expect(report.summary.drift).toBe(1);
    const alter = report.migrationPlan.find((step) => step.kind === "alter_table");
    expect(alter?.target).toBe("orders");
    const alterSql = alter?.sql.join("\n") ?? "";
    expect(alterSql).toContain("ADD COLUMN");
    expect(alterSql).toMatch(/total/);
    expect(alter?.requiresReview).toBe(true);
  });

  it("treats live-only tables as orphans requiring review", () => {
    const legacy: LiveTable = {
      name: "legacy_audit",
      columns: [{ name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true }],
    };
    const report = reconcile({
      liveTables: [liveCustomers(), liveOrders(), legacy],
      liveForeignKeys: [orderFk()],
    });
    expect(report.summary.extra).toBe(1);
    expect(report.orphanTables.map((table) => table.table)).toContain("legacy_audit");
    const review = report.migrationPlan.find((step) => step.kind === "review_orphan_table");
    expect(review?.target).toBe("legacy_audit");
    expect(review?.requiresReview).toBe(true);
    expect(report.openQuestions.some((question) => question.code === "table_not_in_model")).toBe(true);
  });

  it("keeps extra live columns visible in column pairs", () => {
    const customers = liveCustomers();
    customers.columns.push({ name: "legacy_flag", dataType: "tinyint", nullable: true });
    const report = reconcile({
      liveTables: [customers, liveOrders()],
      liveForeignKeys: [orderFk()],
    });
    const customer = report.tables.find((table) => table.logicalName === "Customer");
    const extra = customer?.columns.find((column) => column.name === "legacy_flag");
    expect(extra?.modeled).toBeUndefined();
    expect(extra?.live).toBeDefined();
  });
});

describe("buildReconciliation — determinism and robustness", () => {
  it("is byte-stable for identical inputs", () => {
    expect(JSON.stringify(reconcile())).toBe(JSON.stringify(reconcile()));
  });

  it("handles an empty document", () => {
    const report = reconcile({ doc: { openapi: "3.1.0", paths: {} } });
    expect(report.summary.modeledTables).toBe(0);
    expect(report.tables).toEqual([]);
    expect(report.relationships).toEqual([]);
    expect(report.migrationPlan.every(step => step.requiresReview && step.sql.every(sql => sql.startsWith("-- REVIEW ONLY")))).toBe(true);
  });

  it("handles nullish input without throwing", () => {
    expect(() => buildReconciliation({ doc: null, now: () => new Date(FIXED_NOW) })).not.toThrow();
    expect(() => buildReconciliation({ doc: undefined, now: () => new Date(FIXED_NOW) })).not.toThrow();
  });

  it("defaults to MySQL dialect", () => {
    expect(buildReconciliation({ doc: shopDoc(), now: () => new Date(FIXED_NOW) }).dialect).toBe("mysql");
  });
});
