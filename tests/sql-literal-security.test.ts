import { describe, expect, it } from "vitest";
import { DIALECTS, quoteSqlString } from "../src/dialects";

// Read a MySQL literal using its default backslash escape and doubled-quote rules.
function parseLiteral(text: string): { value: string; rest: string } {
  let value = "";
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "\\") {
      value += text[++i];
      continue;
    }
    if (text[i] === "'") {
      if (text[i + 1] === "'") {
        value += "'";
        i++;
        continue;
      }
      return { value, rest: text.slice(i + 1) };
    }
    value += text[i];
  }
  throw new Error("Unterminated literal");
}

describe("MySQL untrusted string literals", () => {
  it.each([
    "\\'; DROP TABLE users; --",
    "C:\\temp\\file",
    "normal's value",
    "end\\",
  ])("round trips %s without exposing SQL", (input) => {
    expect(parseLiteral(quoteSqlString(input, "mysql"))).toEqual({
      value: input,
      rest: "",
    });
  });
  it("also protects ENUM values", () => {
    const input = "\\'); DROP TABLE users; --";
    const type = DIALECTS.mysql.columnType({
      name: "state",
      columnName: "state",
      jsonType: "string",
      nullable: false,
      primaryKey: false,
      unique: false,
      enumValues: [input],
    });
    expect(parseLiteral(type.slice(5, -1))).toEqual({ value: input, rest: "" });
  });
  it("preserves backslashes in SQL Server and Oracle literals", () => {
    expect(quoteSqlString("C:\\temp", "sqlserver")).toBe("'C:\\temp'");
    expect(quoteSqlString("C:\\temp", "oracle")).toBe("'C:\\temp'");
  });
});
