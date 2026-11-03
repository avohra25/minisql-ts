import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "../src/index";
import { parseStatement } from "../src/parser";

let db: Database;
const rows = (sql: string) => db.exec(sql).rows;

beforeEach(() => {
  db = new Database();
  db.exec(`
    CREATE TABLE emp (id INTEGER PRIMARY KEY, name TEXT, dept TEXT, salary INT, manager INT);
    INSERT INTO emp (name, dept, salary, manager) VALUES
      ('ann', 'eng', 120, NULL), ('bob', 'eng', 100, 1), ('cy', 'ops', 90, 1),
      ('di', 'ops', 70, 3), ('ed', 'ops', 60, 4);
  `);
});

describe("WITH (common table expressions)", () => {
  test("parses names, column lists and materialization hints", () => {
    const s = parseStatement("WITH a(x, y) AS (SELECT 1, 2), b AS MATERIALIZED (SELECT 3), c AS NOT MATERIALIZED (SELECT 4) SELECT * FROM a");
    expect(s.kind).toBe("select");
    if (s.kind !== "select") return;
    expect(s.with!.recursive).toBe(false);
    expect(s.with!.ctes.map((c) => [c.name, c.columns])).toEqual([["a", ["x", "y"]], ["b", undefined], ["c", undefined]]);
    expect(() => parseStatement("WITH a AS (SELECT 1), A AS (SELECT 2) SELECT 1")).toThrow("duplicate WITH table name: A");
    expect(() => parseStatement("WITH a AS SELECT 1 SELECT 1")).toThrow("expected '('");
  });

  test("a CTE works like a named derived table", () => {
    expect(rows("WITH big AS (SELECT name, salary FROM emp WHERE salary >= 90) SELECT name FROM big ORDER BY salary")).toEqual([["cy"], ["bob"], ["ann"]]);
    expect(db.exec("WITH s(total, n) AS (SELECT sum(salary), count(*) FROM emp) SELECT * FROM s").columns).toEqual(["total", "n"]);
  });

  test("later CTEs can use earlier ones, and a CTE can be referenced twice", () => {
    expect(
      rows(`WITH per AS (SELECT dept, avg(salary) AS avg FROM emp GROUP BY dept),
                 top AS (SELECT dept FROM per WHERE avg = (SELECT max(avg) FROM per))
            SELECT e.name FROM emp e JOIN top USING (dept) ORDER BY e.name`),
    ).toEqual([["ann"], ["bob"]]);
    expect(rows("WITH n(v) AS (VALUES (1), (2)) SELECT a.v, b.v FROM n a, n b ORDER BY 1, 2")).toEqual([[1, 1], [1, 2], [2, 1], [2, 2]]);
  });

  test("CTEs shadow tables and are scoped to their statement", () => {
    expect(rows("WITH emp AS (SELECT 'shadow' AS name) SELECT name FROM emp")).toEqual([["shadow"]]);
    expect(rows("SELECT count(*) FROM emp")).toEqual([[5]]);
    expect(() => rows("WITH x AS (SELECT 1) SELECT 1; SELECT * FROM x")).toThrow("no such table: x");
  });

  test("WITH inside subqueries, including correlated ones", () => {
    expect(rows("SELECT name FROM emp WHERE id IN (WITH m AS (SELECT manager FROM emp) SELECT manager FROM m) ORDER BY 1")).toEqual([["ann"], ["cy"], ["di"]]);
    // the CTE body reads the outer row, so it must be re-evaluated (not cached) per row
    expect(rows("SELECT name, (WITH r AS (SELECT count(*) AS n FROM emp x WHERE x.manager = emp.id) SELECT n FROM r) FROM emp ORDER BY id")).toEqual([
      ["ann", 2], ["bob", 0], ["cy", 1], ["di", 1], ["ed", 0],
    ]);
    // ...even when the subquery that reads the CTE does not mention the outer row itself
    expect(rows("SELECT id, (WITH c AS (SELECT emp.id * 10 AS v) SELECT (SELECT v FROM c)) FROM emp ORDER BY id LIMIT 3")).toEqual([[1, 10], [2, 20], [3, 30]]);
  });

  test("WITH feeds INSERT ... SELECT and CREATE TABLE AS", () => {
    db.exec("CREATE TABLE ops AS WITH o AS (SELECT name FROM emp WHERE dept = 'ops') SELECT * FROM o");
    expect(rows("SELECT count(*) FROM ops")).toEqual([[3]]);
    db.exec("INSERT INTO ops WITH z(n) AS (VALUES ('zed')) SELECT n FROM z");
    expect(rows("SELECT name FROM ops ORDER BY name")).toEqual([["cy"], ["di"], ["ed"], ["zed"]]);
  });

  test("errors", () => {
    expect(() => rows("WITH x(a, b) AS (SELECT 1) SELECT * FROM x")).toThrow("table x has 1 values for 2 columns");
    expect(() => rows("WITH x AS (SELECT * FROM y), y AS (SELECT * FROM x) SELECT * FROM x")).toThrow("circular reference: x");
    expect(() => rows("WITH x AS (SELECT * FROM x) SELECT * FROM x")).toThrow("circular reference: x");
    expect(() => rows("WITH x AS (SELECT * FROM nope) SELECT 1")).not.toThrow(); // never referenced, never run
  });

  test("a CTE may refer to one defined after it", () => {
    expect(rows("WITH a AS (SELECT v * 2 AS w FROM b), b(v) AS (VALUES (1), (5)) SELECT w FROM a ORDER BY w")).toEqual([[2], [10]]);
  });
});
