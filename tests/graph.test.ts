import { buildGraph, tableKey } from "../src/graph";
import { extractEntities } from "../src";
import type { LiveForeignKey, LiveTable, ModelEntity } from "../src";
import { shopDoc, liveCustomers, liveOrders, orderFk } from "./fixtures/shop";

function modeledEntities(): ModelEntity[] {
  return extractEntities(shopDoc());
}

describe("tableKey", () => {
  it("strips schema prefixes, brackets and quotes and lower-cases", () => {
    expect(tableKey("dbo.Orders")).toBe("orders");
    expect(tableKey("[dbo].[Users]")).toBe("users");
    expect(tableKey('"PUBLIC"."CUSTOMERS"')).toBe("customers");
    expect(tableKey("order_items")).toBe("order_items");
  });
});

describe("buildGraph", () => {
  it("returns an empty graph for no entities", () => {
    const graph = buildGraph([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.relationships).toEqual([]);
    expect(graph.summary.tables).toBe(0);
  });

  it("marks every modeled table as missing without live evidence", () => {
    const graph = buildGraph(modeledEntities());
    expect(graph.nodes).toHaveLength(2);
    expect(graph.summary.missing).toBe(2);
    expect(graph.summary.matched).toBe(0);
    expect(graph.nodes.every((node) => node.status === "missing")).toBe(true);
  });

  it("creates a model relationship from object $ref properties", () => {
    const graph = buildGraph(modeledEntities());
    const edge = graph.relationships.find((relationship) => relationship.fromColumn === "customer");
    expect(edge).toBeDefined();
    expect(edge?.origin).toBe("model");
    expect(edge?.enforced).toBe(false);
    expect(edge?.confidence).toBe("high");
    expect(tableKey(edge?.toTable ?? "")).toBe("customers");
    expect(edge?.toColumn).toBe("id");
    expect(graph.summary.relationships).toBe(1);
  });

  it("matches live tables and merges an enforced foreign key", () => {
    const graph = buildGraph(modeledEntities(), {
      liveTables: [liveCustomers(), liveOrders()],
      liveForeignKeys: [orderFk()],
    });
    expect(graph.summary.matched).toBe(2);
    expect(graph.summary.missing).toBe(0);
    const edge = graph.relationships.find((relationship) => relationship.fromColumn === "customer");
    expect(edge?.origin).toBe("both");
    expect(edge?.enforced).toBe(true);
  });

  it("matches schema-qualified live table and constraint names", () => {
    const customers = liveCustomers();
    const orders = liveOrders();
    customers.schema = "dbo";
    orders.schema = "dbo";
    const fk: LiveForeignKey = {
      table: "dbo.orders",
      column: "customer",
      refTable: "dbo.customers",
      refColumn: "id",
    };
    const graph = buildGraph(modeledEntities(), { liveTables: [customers, orders], liveForeignKeys: [fk] });
    expect(graph.summary.matched).toBe(2);
    expect(graph.relationships[0]?.enforced).toBe(true);
  });

  it("classifies a table with a missing modeled column as drift", () => {
    const graph = buildGraph(modeledEntities(), {
      liveTables: [liveCustomers(), liveOrders(false)],
    });
    expect(graph.summary.drift).toBe(1);
    const node = graph.nodes.find((candidate) => candidate.id === "orders");
    expect(node?.status).toBe("drift");
    expect(node?.diffs.some((item) => item.kind === "missing_column")).toBe(true);
  });

  it("reports live-only tables as extra", () => {
    const legacy: LiveTable = {
      name: "legacy_audit",
      columns: [{ name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true }],
    };
    const graph = buildGraph(modeledEntities(), {
      liveTables: [liveCustomers(), liveOrders(), legacy],
    });
    expect(graph.summary.extra).toBe(1);
    const node = graph.nodes.find((candidate) => candidate.id === "legacy_audit");
    expect(node?.status).toBe("extra");
    expect(node?.modeled).toBe(false);
    expect(node?.live).toBe(true);
  });

  it("keeps a live-only foreign key as a live edge", () => {
    const audit: LiveTable = {
      name: "audit_logs",
      columns: [
        { name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true },
        { name: "customer", dataType: "bigint", nullable: true },
      ],
    };
    const graph = buildGraph(modeledEntities(), {
      liveTables: [liveCustomers(), liveOrders(), audit],
      liveForeignKeys: [
        orderFk(),
        { table: "audit_logs", column: "customer", refTable: "customers", refColumn: "id" },
      ],
    });
    const liveEdge = graph.relationships.find((edge) => edge.fromTable === "audit_logs");
    expect(liveEdge?.origin).toBe("live");
    expect(liveEdge?.enforced).toBe(true);
  });
});
