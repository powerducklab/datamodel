import type { DataModelReconciliation, ReconciliationTable } from "./reconciliation";
import { tableKey, type GraphRelationship } from "./graph";
import type { LiveColumn } from "./types";

/**
 * Artifact exporters.
 *
 * Two representations are produced from the same reconciliation object:
 *   - JSON is the canonical machine-readable contract for AI agents, the MCP
 *     server and automation;
 *   - Markdown is a compact human/model brief that embeds a Mermaid `erDiagram`
 *     (plain text, diffable, rendered by GitHub and understood by coding
 *     agents), followed by per-table evidence, additive SQL, an ordered
 *     migration plan, open questions and safeguards.
 *
 * Nothing here performs I/O; callers write the returned string to disk, copy
 * it into a prompt, or send it over MCP.
 */

export const MAX_MERMAID_TABLES = 40;
export const MAX_MERMAID_COLUMNS = 20;

const DIALECT_LABEL: Record<string, string> = {
  mysql: "MySQL",
  sqlserver: "SQL Server",
  oracle: "Oracle",
};

/** Serialize the artifact to canonical, indented JSON. */
export function exportReconciliationJson(reconciliation: DataModelReconciliation): string {
  return `${JSON.stringify(reconciliation, null, 2)}\n`;
}

function sanitizeAlias(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/\./g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
  return `t_${cleaned || "table"}`;
}

function buildAliases(tables: ReconciliationTable[], orphans: { table: string }[]): Map<string, string> {
  const aliases = new Map<string, string>();
  const used = new Set<string>();
  const assign = (table: string) => {
    const base = sanitizeAlias(table);
    let alias = base;
    let counter = 2;
    while (used.has(alias)) alias = `${base}_${counter++}`;
    used.add(alias);
    aliases.set(table, alias);
  };
  for (const table of tables) assign(table.table);
  for (const orphan of orphans) assign(orphan.table);
  return aliases;
}

function mermaidTypeFromModel(jsonType: string, format?: string): string {
  if (jsonType === "integer") return format === "int64" ? "bigint" : "int";
  if (jsonType === "number") return "decimal";
  if (jsonType === "boolean") return "boolean";
  if (jsonType === "object" || jsonType === "array") return "json";
  switch (format) {
    case "date":
      return "date";
    case "date-time":
    case "timestamp":
      return "datetime";
    case "time":
      return "time";
    case "uuid":
      return "char";
    case "binary":
    case "byte":
      return "blob";
    default:
      return "varchar";
  }
}

function mermaidTypeFromLive(dataType: string | undefined): string {
  const raw = (dataType ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (/^(bit|bool|boolean|tinyint\(1\))$/.test(raw)) return "boolean";
  if (/^(bigint|serial|bigserial)$/.test(raw)) return "bigint";
  if (/^(tinyint|smallint|mediumint|int|integer)$/.test(raw)) return "int";
  if (/^(decimal|numeric|number|float|double|real|money)$/.test(raw) || /^(decimal|numeric|float|double)/.test(raw)) {
    return "decimal";
  }
  if (/^(datetime2?|timestamp|smalldatetime)/.test(raw)) return "datetime";
  if (/^date/.test(raw)) return "date";
  if (/^time/.test(raw)) return "time";
  if (/^(json|jsonb)$/.test(raw)) return "json";
  if (/^(blob|varbinary|binary|image|bytea)/.test(raw)) return "blob";
  if (/^(uniqueidentifier|uuid)$/.test(raw)) return "char";
  if (/^(char|nchar|varchar|nvarchar|varchar2|text|clob|nclob|long)/.test(raw)) {
    return /^(text|clob|nclob|long)/.test(raw) ? "text" : "varchar";
  }
  return "varchar";
}

function fkColumnSet(relationships: GraphRelationship[]): Map<string, Set<string>> {
  const byTable = new Map<string, Set<string>>();
  for (const relationship of relationships) {
    const key = relationship.fromTable.toLowerCase();
    const set = byTable.get(key) ?? new Set<string>();
    set.add(relationship.fromColumn.toLowerCase());
    byTable.set(key, set);
  }
  return byTable;
}

function diagramRows(
  tableName: string,
  table: ReconciliationTable | undefined,
  orphan: LiveColumn[] | undefined,
  fkSet: Set<string> | undefined,
  compositePk?: Set<string>,
): string[] {
  const lines: string[] = [];
  const columns: Array<{ name: string; type: string; pk: boolean; fk: boolean }> = [];

  if (table) {
    for (const pair of table.columns) {
      const type = pair.modeled
        ? mermaidTypeFromModel(pair.modeled.jsonType, pair.modeled.format)
        : mermaidTypeFromLive(pair.live?.dataType);
      const pk =
        pair.modeled?.primaryKey === true ||
        compositePk?.has(pair.name.toLowerCase()) === true ||
        pair.live?.primaryKey === true;
      const fk = fkSet?.has(pair.name.toLowerCase()) === true;
      columns.push({ name: pair.name, type, pk, fk });
    }
  } else if (orphan) {
    for (const column of orphan) {
      columns.push({
        name: column.name,
        type: mermaidTypeFromLive(column.dataType),
        pk: column.isPrimaryKey === true,
        fk: false,
      });
    }
  }

  for (const column of columns.slice(0, MAX_MERMAID_COLUMNS)) {
    const marker = column.pk ? " PK" : column.fk ? " FK" : "";
    lines.push(`    ${column.type} ${column.name}${marker}`);
  }
  if (columns.length > MAX_MERMAID_COLUMNS) {
    lines.push(`    %% ${columns.length - MAX_MERMAID_COLUMNS} more columns omitted`);
  }
  return lines;
}

/** Build a Mermaid erDiagram string for the artifact. */
export function buildMermaidErDiagram(
  reconciliation: DataModelReconciliation,
): string {
  const { tables, orphanTables, relationships } = reconciliation;
  const aliases = buildAliases(tables, orphanTables);
  const fkByTable = fkColumnSet(relationships);

  // Resolve aliases by the same schema-stripped key used by the graph so that
  // live qualified names ("dbo.orders") still match modeled names ("orders").
  const aliasByKey = new Map<string, string>();
  const registerAlias = (table: string) => {
    const alias = aliases.get(table);
    if (alias) aliasByKey.set(tableKey(table), alias);
  };
  for (const table of tables) registerAlias(table.table);
  for (const orphan of orphanTables) registerAlias(orphan.table);

  const shownTables = tables.slice(0, MAX_MERMAID_TABLES);
  const shownOrphans = orphanTables.slice(0, Math.max(0, MAX_MERMAID_TABLES - shownTables.length));
  const shownKeys = new Set<string>([
    ...shownTables.map((table) => tableKey(table.table)),
    ...shownOrphans.map((orphan) => tableKey(orphan.table)),
  ]);

  const blocks: string[] = ["erDiagram"];

  for (const table of shownTables) {
    const alias = aliases.get(table.table);
    if (!alias) continue;
    const compositePk = new Set(
      (table.compositePrimaryKey ?? []).map((column) => column.toLowerCase()),
    );
    blocks.push(`  ${alias} {`);
    blocks.push(
      ...diagramRows(
        table.table,
        table,
        undefined,
        fkByTable.get(tableKey(table.table)),
        compositePk,
      ),
    );
    blocks.push("  }");
  }
  for (const orphan of shownOrphans) {
    const alias = aliases.get(orphan.table);
    if (!alias) continue;
    blocks.push(`  ${alias} {`);
    blocks.push(...diagramRows(orphan.table, undefined, orphan.columns, fkByTable.get(tableKey(orphan.table))));
    blocks.push("  }");
  }

  for (const relationship of relationships) {
    if (!shownKeys.has(tableKey(relationship.fromTable)) ||
        !shownKeys.has(tableKey(relationship.toTable))) {
      continue;
    }
    const child = aliasByKey.get(tableKey(relationship.fromTable));
    const parent = aliasByKey.get(tableKey(relationship.toTable));
    if (!child || !parent) continue;
    const marker = relationship.enforced ? "" : " %% not enforced in live database";
    blocks.push(`  ${parent} ||--o{ ${child} : "${relationship.fromColumn}"${marker}`);
  }

  const totalTables = tables.length + orphanTables.length;
  if (totalTables > MAX_MERMAID_TABLES) {
    blocks.push(`  %% ${totalTables - MAX_MERMAID_TABLES} tables omitted; see reconciliation.json for the full graph`);
  }
  return blocks.join("\n");
}

function sqlBlock(statements: string[]): string {
  if (!statements.length) return "";
  return ["```sql", ...statements, "```"].join("\n");
}

function operationsLine(operations: string[]): string {
  if (!operations.length) return "_No linked API operations._";
  return operations.map((operation) => `\`${operation}\``).join(", ");
}

function diffsLines(table: ReconciliationTable): string[] {
  return table.diffs.map((item) => {
    const tag =
      item.severity === "actionable"
        ? "actionable"
        : item.severity === "warning"
          ? "warning"
          : "info";
    return `- **[${tag}]** ${item.message}`;
  });
}

function tableSection(title: string, hint: string, tables: ReconciliationTable[], lines: string[]): void {
  if (!tables.length) return;
  lines.push(`## ${title}`, "", hint, "");
  for (const table of tables) {
    lines.push(`### \`${table.table}\`${table.logicalName ? ` — ${table.logicalName}` : ""}`, "");
    lines.push(`- **Status:** ${table.status} · **confidence:** ${table.confidence}`);
    if (table.source) lines.push(`- **Model source:** ${table.source}`);
    lines.push(`- **Impacted operations:** ${operationsLine(table.impactedOperations)}`);
    const diffs = diffsLines(table);
    if (diffs.length) {
      lines.push("- **Differences:**", ...diffs);
    }
    const create = sqlBlock(table.proposedSql.createStatements);
    const alter = sqlBlock(table.proposedSql.alterStatements);
    if (create) lines.push("", create);
    if (alter) lines.push("", alter);
    lines.push("");
  }
}

/** Render the artifact as a self-contained, agent-friendly Markdown brief. */
export function exportReconciliationMarkdown(reconciliation: DataModelReconciliation): string {
  const { summary, source } = reconciliation;
  const dialect = DIALECT_LABEL[reconciliation.dialect] ?? reconciliation.dialect;
  const lines: string[] = [];

  const title = source.spec?.title ?? "Untitled API";
  lines.push(`# Data Model Reconciliation — ${title}`, "");
  lines.push(
    `_Generated ${reconciliation.generatedAt} · Dialect: ${dialect} · Artifact schema v${reconciliation.schemaVersion}_`,
    "",
  );
  lines.push(
    "> Facts are computed deterministically by `@powerduck/datamodel`. The companion `reconciliation.json` is the machine-readable source of truth. Review SQL before executing; PowerDuck never runs DDL/DML.",
    "",
  );

  lines.push("## Summary", "");
  lines.push("| Metric | Count |");
  lines.push("| --- | ---: |");
  lines.push(`| Modeled tables | ${summary.modeledTables} |`);
  lines.push(`| Live tables | ${summary.liveTables} |`);
  lines.push(`| Relationships | ${summary.relationships} (${summary.enforcedRelationships} enforced, ${summary.unenforcedRelationships} unenforced) |`);
  lines.push(`| New tables (missing) | ${summary.missing} |`);
  lines.push(`| Drifting tables | ${summary.drift} |`);
  lines.push(`| Matched tables | ${summary.matched} |`);
  lines.push(`| Tables only in database | ${summary.extra} |`);
  lines.push(`| Actionable differences | ${summary.actionableItems} |`);
  lines.push(`| Warnings | ${summary.warningItems} |`);
  lines.push("");

  lines.push("## Entity-relationship overview", "");
  lines.push("```mermaid", buildMermaidErDiagram(reconciliation), "```", "");

  const missing = reconciliation.tables.filter((table) => table.status === "missing");
  const drift = reconciliation.tables.filter((table) => table.status === "drift");
  const matched = reconciliation.tables.filter((table) => table.status === "matched");

  tableSection(
    "New tables (missing from the database)",
    "Modeled tables with no live counterpart. Create them in dependency order.",
    missing,
    lines,
  );
  tableSection(
    "Drifting tables",
    "The table exists but columns or types differ. Proposed changes are additive only.",
    drift,
    lines,
  );

  if (matched.length) {
    lines.push("## Matched tables", "");
    lines.push(
      matched.map((table) => `\`${table.table}\``).join(", "),
      "",
    );
  }

  if (reconciliation.orphanTables.length) {
    lines.push("## Tables only in the database", "");
    lines.push(
      "These live tables have no counterpart in the API model. They are kept as-is; reverse-engineer a component schema if the API should expose them.",
      "",
    );
    for (const orphan of reconciliation.orphanTables) {
      lines.push(`- \`${orphan.table}\` — ${orphan.columns.length} columns`);
    }
    lines.push("");
  }

  if (reconciliation.migrationPlan.length) {
    lines.push("## Migration plan", "");
    lines.push("Execute steps in order; honor `blockedBy` and review any step marked for review.", "");
    for (const step of reconciliation.migrationPlan) {
      const blocked = step.blockedBy.length ? ` · blocked by step(s) ${step.blockedBy.join(", ")}` : "";
      const review = step.requiresReview ? " · **review required**" : "";
      lines.push(`### Step ${step.order} — ${step.kind} · \`${step.target}\`${review}`, "");
      lines.push(`${step.description}${blocked}`, "");
      const sql = sqlBlock(step.sql);
      if (sql) lines.push(sql, "");
    }
  }

  if (reconciliation.openQuestions.length) {
    lines.push("## Open questions", "");
    for (const question of reconciliation.openQuestions) {
      const target = question.table ? ` (\`${question.table}\`)` : "";
      lines.push(`- **[${question.severity}] ${question.code}**${target}: ${question.message}`);
    }
    lines.push("");
  }

  lines.push("## Safeguards", "");
  for (const safeguard of reconciliation.safeguards) lines.push(`- ${safeguard}`);
  lines.push("");

  lines.push("---", "");
  lines.push(
    "Learn more: [PowerDuck](https://www.powerduck.com/) · [Documentation](https://www.powerduck.com/docs/getting-started/introduction)",
  );

  return lines.join("\n");
}
