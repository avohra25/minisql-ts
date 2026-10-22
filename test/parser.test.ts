import { describe, expect, test } from "bun:test";
import type { Expr, SelectStmt } from "../src/ast";
import { SqlSyntaxError } from "../src/lexer";
import { parse, parseExpr, parseStatement } from "../src/parser";

/** Render an expression back to a fully parenthesised string to check precedence. */
function show(e: Expr): string {
  switch (e.kind) {
    case "literal":
      return e.value === null ? "NULL" : typeof e.value === "string" ? `'${e.value}'` : String(e.value);
    case "column":
      return e.table ? `${e.table}.${e.name}` : e.name;
    case "param":
      return `?${e.key}`;
    case "unary":
      return `(${e.op} ${show(e.expr)})`;
    case "binary":
      return `(${show(e.left)} ${e.op} ${show(e.right)})`;
    case "isNull":
      return `(${show(e.expr)} IS ${e.not ? "NOT " : ""}NULL)`;
    case "is":
      return `(${show(e.left)} IS ${e.not ? "NOT " : ""}${show(e.right)})`;
    case "between":
      return `(${show(e.expr)} ${e.not ? "NOT " : ""}BETWEEN ${show(e.low)} AND ${show(e.high)})`;
    case "inList":
      return `(${show(e.expr)} ${e.not ? "NOT " : ""}IN [${e.list.map(show).join(", ")}])`;
    case "like":
      return `(${show(e.expr)} ${e.not ? "NOT " : ""}LIKE ${show(e.pattern)})`;
    case "call":
      return `${e.name}(${e.distinct ? "DISTINCT " : ""}${e.star ? "*" : e.args.map(show).join(", ")})`;
    case "case":
      return `CASE${e.base ? " " + show(e.base) : ""}${e.whens.map((w) => ` WHEN ${show(w.when)} THEN ${show(w.then)}`).join("")}${e.else ? " ELSE " + show(e.else) : ""} END`;
    case "cast":
      return `CAST(${show(e.expr)} AS ${e.type})`;
    default:
      return `<${e.kind}>`;
  }
}

const p = (sql: string) => show(parseExpr(sql));

describe("expression precedence", () => {
  test("arithmetic", () => {
    expect(p("1 + 2 * 3")).toBe("(1 + (2 * 3))");
    expect(p("(1 + 2) * 3")).toBe("((1 + 2) * 3)");
    expect(p("1 - 2 - 3")).toBe("((1 - 2) - 3)");
    expect(p("a || b * c")).toBe("(a || b * c)".replace("a || b * c", "(a || b) * c"));
  });

  test("boolean operators", () => {
    expect(p("a OR b AND c")).toBe("(a OR (b AND c))");
    expect(p("NOT a = b")).toBe("(NOT (a = b))");
    expect(p("a < b = c < d")).toBe("((a < b) = (c < d))");
    expect(p("a <> b")).toBe("(a != b)");
  });

  test("negative literals fold, unary minus on columns stays", () => {
    expect(parseExpr("-5")).toEqual({ kind: "literal", value: -5n });
    expect(parseExpr("-9223372036854775808")).toEqual({ kind: "literal", value: -9223372036854775808n });
    expect(p("-x")).toBe("(- x)");
    expect(p("1 - -2")).toBe("(1 - -2)");
  });

  test("special predicates", () => {
    expect(p("x IS NULL")).toBe("(x IS NULL)");
    expect(p("x IS NOT NULL AND y NOTNULL")).toBe("((x IS NOT NULL) AND (y IS NOT NULL))");
    expect(p("x IS NOT y")).toBe("(x IS NOT y)");
    expect(p("x BETWEEN 1 AND 2 AND y")).toBe("((x BETWEEN 1 AND 2) AND y)");
    expect(p("x NOT IN (1, 2)")).toBe("(x NOT IN [1, 2])");
    expect(p("x IN ()")).toBe("(x IN [])");
    expect(p("name NOT LIKE 'a%'")).toBe("(name NOT LIKE 'a%')");
  });

  test("calls, case, cast", () => {
    expect(p("count(*)")).toBe("count(*)");
    expect(p("COUNT(DISTINCT a)")).toBe("count(DISTINCT a)");
    expect(p("coalesce(a, b, 0)")).toBe("coalesce(a, b, 0)");
    expect(p("CASE WHEN a THEN 1 ELSE 2 END")).toBe("CASE WHEN a THEN 1 ELSE 2 END");
    expect(p("CASE x WHEN 1 THEN 'one' END")).toBe("CASE x WHEN 1 THEN 'one' END");
    expect(p("CAST(a AS INTEGER)")).toBe("CAST(a AS INTEGER)");
  });

  test("literals and parameters", () => {
    expect(parseExpr("1.5")).toEqual({ kind: "literal", value: 1.5 });
    expect(parseExpr("TRUE")).toEqual({ kind: "literal", value: 1n });
    expect(parseExpr("'hi'")).toEqual({ kind: "literal", value: "hi" });
    expect(parseExpr("99999999999999999999")).toEqual({ kind: "literal", value: 1e20 });
    expect(p("? + ? + ?5 + ?")).toBe("(((?1 + ?2) + ?5) + ?6)");
    expect(p(":name")).toBe("?:name");
    expect(p("t.col")).toBe("t.col");
  });
});

describe("statements", () => {
  test("select with every clause", () => {
    const s = parseStatement(
      "SELECT DISTINCT a, b AS bee, count(*) n FROM t WHERE a > 1 GROUP BY a, b HAVING count(*) > 1 ORDER BY 1 DESC, bee LIMIT 10 OFFSET 5",
    ) as SelectStmt;
    expect(s.kind).toBe("select");
    expect(s.core.distinct).toBe(true);
    expect(s.core.columns.map((c) => (c.kind === "expr" ? [c.text, c.alias] : "*"))).toEqual([
      ["a", undefined], ["b", "bee"], ["count(*)", "n"],
    ]);
    expect(s.core.groupBy).toHaveLength(2);
    expect(s.core.having).toBeDefined();
    expect(s.orderBy.map((o) => o.desc)).toEqual([true, false]);
    expect(s.limit).toEqual({ kind: "literal", value: 10n });
    expect(s.offset).toEqual({ kind: "literal", value: 5n });
  });

  test("LIMIT offset, count form", () => {
    const s = parseStatement("SELECT 1 LIMIT 3, 7") as SelectStmt;
    expect(s.offset).toEqual({ kind: "literal", value: 3n });
    expect(s.limit).toEqual({ kind: "literal", value: 7n });
  });

  test("joins nest left-deep", () => {
    const s = parseStatement("SELECT * FROM a JOIN b ON a.id = b.a_id LEFT JOIN c USING (id), d") as SelectStmt;
    const f = s.core.from!;
    expect(f.kind).toBe("join");
    if (f.kind !== "join") throw new Error();
    expect(f.type).toBe("CROSS");
    if (f.left.kind !== "join") throw new Error();
    expect(f.left.type).toBe("LEFT");
    expect(f.left.using).toEqual(["id"]);
    if (f.left.left.kind !== "join") throw new Error();
    expect(f.left.left.type).toBe("INNER");
  });

  test("subqueries", () => {
    const s = parseStatement(
      "SELECT x.* FROM (SELECT 1 AS v) x WHERE v IN (SELECT 1) AND EXISTS (SELECT 1) AND (SELECT 2) = 2",
    ) as SelectStmt;
    expect(s.core.columns[0]).toEqual({ kind: "star", table: "x" });
    expect(s.core.from!.kind).toBe("subquery");
  });

  test("compound selects", () => {
    const s = parseStatement("SELECT 1 UNION ALL SELECT 2 UNION SELECT 3 EXCEPT SELECT 4 ORDER BY 1") as SelectStmt;
    expect(s.compounds.map((c) => c.op)).toEqual(["UNION ALL", "UNION", "EXCEPT"]);
    expect(s.orderBy).toHaveLength(1);
  });

  test("create table", () => {
    const s = parseStatement(
      "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, age INT DEFAULT 0, note, UNIQUE (email, age))",
    );
    expect(s).toMatchObject({
      kind: "createTable",
      name: "users",
      ifNotExists: true,
      uniques: [["email", "age"]],
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "email", type: "VARCHAR", notNull: true, unique: true },
        { name: "age", type: "INT", default: { kind: "literal", value: 0n } },
        { name: "note", type: "" },
      ],
    });
  });

  test("insert forms", () => {
    expect(parseStatement("INSERT INTO t (a, b) VALUES (1, 2), (3, 4)")).toMatchObject({
      kind: "insert", columns: ["a", "b"], source: { kind: "values" },
    });
    expect(parseStatement("INSERT INTO t SELECT * FROM u")).toMatchObject({ source: { kind: "select" } });
    expect(parseStatement("INSERT OR REPLACE INTO t VALUES (1)")).toMatchObject({ orReplace: true });
    expect(parseStatement("REPLACE INTO t VALUES (1)")).toMatchObject({ orReplace: true });
    expect(parseStatement("INSERT OR IGNORE INTO t DEFAULT VALUES")).toMatchObject({ orIgnore: true, source: { kind: "defaults" } });
  });

  test("update, delete, drop, transactions", () => {
    expect(parseStatement("UPDATE t SET a = a + 1, b = 'x' WHERE id = 3")).toMatchObject({ kind: "update", set: [{ column: "a" }, { column: "b" }] });
    expect(parseStatement("DELETE FROM t")).toEqual({ kind: "delete", table: "t", where: undefined });
    expect(parseStatement("DROP TABLE IF EXISTS t")).toEqual({ kind: "dropTable", name: "t", ifExists: true });
    expect(parse("BEGIN; COMMIT; BEGIN TRANSACTION; ROLLBACK;").map((s) => s.kind)).toEqual(["begin", "commit", "begin", "rollback"]);
  });

  test("scripts and empty statements", () => {
    expect(parse(";;SELECT 1;; SELECT 2;")).toHaveLength(2);
    expect(parse("")).toEqual([]);
  });

  test("syntax errors point at the offending token", () => {
    expect(() => parse("SELECT FROM t")).toThrow(SqlSyntaxError);
    expect(() => parse("SELECT 1 2")).toThrow(/near '2'/);
    expect(() => parse("SELEC 1")).toThrow(/expected a statement/);
    expect(() => parse("SELECT (1")).toThrow(/end of input/);
    expect(() => parse("INSERT INTO t VALUES (1), (1, 2)")).toThrow(/same number/);
    expect(() => parseExpr("1 +")).toThrow(SqlSyntaxError);
    expect(() => parseExpr("1 1")).toThrow(/trailing/);
  });
});
