import {
  buildReconciliation,
  exportReconciliationJson,
  exportReconciliationMarkdown,
  buildMermaidErDiagram,
  MAX_MERMAID_TABLES,
  MAX_MERMAID_COLUMNS,
  type DataModelReconciliation,
  type BuildReconciliationOptions,
} from "../src";
import type { LiveTable } from "../src";
import { shopDoc, liveCustomers, liveOrders, orderFk } from "./fixtures/shop";

const FIXED_NOW = "2024-06-01T00:00:00.000Z";

function report(overrides: Partial<BuildReconciliationOptions> = {}): DataModelReconciliation {
  return buildReconciliation({ doc: shopDoc(), now: () => new Date(FIXED_NOW), ...overrides });
}

describe("exportReconciliationJson", () => {
  it("round-trips through JSON.parse", () => {
    const text = exportReconciliationJson(report());
    const parsed = JSON.parse(text) as DataModelReconciliation;
    expect(parsed.schemaVersion).toBe(report().schemaVersion);
    expect(parsed.summary.modeledTables).toBe(2);
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("buildMermaidErDiagram", () => {
  it("starts with erDiagram and renders entities and the relationship", () => {
    const mermaid = buildMermaidErDiagram(report());
    expect(mermaid.startsWith("erDiagram")).toBe(true);
    expect(mermaid).toContain("t_customers");
    expect(mermaid).toContain("t_orders");
    expect(mermaid).toMatch(/t_customers\s+\|\|--o\{\s+t_orders\s*:\s*"customer"/);
  });

  it("marks primary and foreign keys", () => {
    const mermaid = buildMermaidErDiagram(report());
    expect(mermaid).toMatch(/\bid\s+PK/);
    expect(mermaid).toMatch(/customer\s+FK/);
  });

  it("annotates unenforced relationships but not enforced ones", () => {
    const unenforced = buildMermaidErDiagram(report({ liveTables: [liveCustomers(), liveOrders()] }));
    expect(unenforced).toContain("%% not enforced in live database");

    const enforced = buildMermaidErDiagram(
      report({ liveTables: [liveCustomers(), liveOrders()], liveForeignKeys: [orderFk()] }),
    );
    expect(enforced).not.toContain("not enforced in live database");
  });

  it("omits tables beyond the cap with an explicit note", () => {
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < MAX_MERMAID_TABLES + 5; i += 1) {
      schemas[`T${i}`] = {
        type: "object",
        properties: { id: { type: "integer" }, name: { type: "string" } },
      };
    }
    const large = buildReconciliation({
      doc: { openapi: "3.1.0", paths: {}, components: { schemas } },
      now: () => new Date(FIXED_NOW),
    });
    expect(buildMermaidErDiagram(large)).toContain("tables omitted");
    expect(large.summary.modeledTables).toBe(MAX_MERMAID_TABLES + 5);
  });

  it("omits columns beyond the cap with an explicit note", () => {
    const properties: Record<string, unknown> = { id: { type: "integer" } };
    for (let i = 0; i < MAX_MERMAID_COLUMNS + 5; i += 1) {
      properties[`field_${i}`] = { type: "string" };
    }
    const wide = buildReconciliation({
      doc: {
        openapi: "3.1.0",
        paths: {},
        components: { schemas: { Wide: { type: "object", properties } } },
      },
      now: () => new Date(FIXED_NOW),
    });
    expect(buildMermaidErDiagram(wide)).toContain("more columns omitted");
  });
});

describe("exportReconciliationMarkdown", () => {
  it("contains the summary, embedded mermaid, migration plan and official links", () => {
    const md = exportReconciliationMarkdown(report());
    expect(md).toContain("# Data Model Reconciliation — Shop API");
    expect(md).toContain("## Summary");
    expect(md).toContain("```mermaid");
    expect(md).toContain("erDiagram");
    expect(md).toContain("## New tables");
    expect(md).toContain("```sql");
    expect(md).toContain("CREATE TABLE");
    expect(md).toContain("## Migration plan");
    expect(md).toContain("Step 1");
    expect(md).toContain("## Safeguards");
    expect(md).toContain("https://www.powerduck.com/");
  });

  it("lists impacted operations on each table", () => {
    const md = exportReconciliationMarkdown(report());
    expect(md).toContain("`POST /orders`");
    expect(md).toContain("`GET /customers/{id}`");
  });

  it("renders orphan tables in a dedicated section", () => {
    const legacy: LiveTable = {
      name: "legacy_audit",
      columns: [{ name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true }],
    };
    const md = exportReconciliationMarkdown(
      report({ liveTables: [liveCustomers(), liveOrders(), legacy], liveForeignKeys: [orderFk()] }),
    );
    expect(md).toContain("## Tables only in the database");
    expect(md).toContain("`legacy_audit`");
  });

  it("is written entirely in English", () => {
    expect(/[\u4e00-\u9fff]/.test(exportReconciliationMarkdown(report()))).toBe(false);
  });
});
