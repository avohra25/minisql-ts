import { beforeEach, describe, expect, test } from "bun:test";
import { Database, SqlError } from "../src/index";

let db: Database;

const rows = (sql: string, params: unknown[] | Record<string, unknown> = []) => db.exec(sql, params as never).rows;
const one = (sql: string) => rows(sql)[0]![0];

beforeEach(() => {
  db = new Database();
  db.exec(`
    CREATE TABLE emp (id INTEGER PRIMARY KEY, name TEXT NOT NULL, dept TEXT, salary INT, manager INT);
    INSERT INTO emp (name, dept, salary, manager) VALUES
      ('ann', 'eng', 120, NULL), ('bob', 'eng', 100, 1), ('cy', 'ops', 90, 1),
      ('di', NULL, 70, 3), ('ed', 'ops', NULL, 3);
    CREATE TABLE dept (name TEXT PRIMARY KEY, floor INT);
    INSERT INTO dept VALUES ('eng', 3), ('ops', 1), ('hr', 2);
  `);
});

describe("expressions", () => {
  test("integer vs real arithmetic", () => {
    expect(rows("SELECT 7 / 2, 7.0 / 2, -7 / 2, 7 % 3, -7 % 3, 2 * 3.5, 1 + 1")).toEqual([[3, 3.5, -3, 1, -1, 7, 2]]);
    expect(rows("SELECT 1 / 0, 1 % 0, 1.5 / 0")).toEqual([[null, null, null]]);
  });

  test("64-bit integers are exact and overflow to real", () => {
    const big = new Database({ safeIntegers: true });
    expect(big.exec("SELECT 9223372036854775807, 9223372036854775807 + 1, -9223372036854775808").rows).toEqual([
      [9223372036854775807n, 9223372036854775808, -9223372036854775808n],
    ]);
    expect(big.exec("SELECT 4611686018427387904 * 2").rows[0]![0]).toBe(9223372036854775808);
  });

  test("NULL propagates and three-valued logic", () => {
    expect(rows("SELECT NULL + 1, NULL = NULL, NULL IS NULL, 1 IS NOT NULL, NULL AND 0, NULL AND 1, NULL OR 1, NULL OR 0, NOT NULL")).toEqual([
      [null, null, 1, 1, 0, null, 1, null, null],
    ]);
    expect(rows("SELECT NULL IS NULL, 1 IS 1, NULL IS 1, 2 IS NOT 3")).toEqual([[1, 1, 0, 1]]);
  });

  test("comparisons across types", () => {
    expect(rows("SELECT 1 = 1.0, 2 > 1.5, 'a' < 'b', 'abc' > 10, 1 <> 2, 3 BETWEEN 1 AND 3, 4 NOT BETWEEN 1 AND 3")).toEqual([[1, 1, 1, 1, 1, 1, 1]]);
  });

  test("IN lists follow SQL NULL rules", () => {
    expect(rows("SELECT 1 IN (1, 2), 3 IN (1, 2), 3 IN (1, NULL), 3 NOT IN (1, NULL), NULL IN (1), 1 IN ()")).toEqual([[1, 0, null, null, null, 0]]);
  });

  test("LIKE", () => {
    expect(rows("SELECT 'Hello' LIKE 'h%', 'Hello' LIKE 'h_llo', 'Hello' LIKE '%z%', 'a%b' LIKE 'a!%b' ESCAPE '!', 'axb' LIKE 'a!%b' ESCAPE '!'")).toEqual([[1, 1, 0, 1, 0]]);
    expect(rows("SELECT 'line1\nline2' LIKE 'line1%', NULL LIKE 'x'")).toEqual([[1, null]]);
  });

  test("CASE, CAST and string concatenation", () => {
    expect(rows("SELECT CASE 2 WHEN 1 THEN 'one' WHEN 2 THEN 'two' END, CASE WHEN 0 THEN 'a' ELSE 'b' END, CASE 3 WHEN 1 THEN 'x' END")).toEqual([["two", "b", null]]);
    expect(rows("SELECT CAST('42abc' AS INTEGER), CAST(3.9 AS INT), CAST(5 AS REAL), CAST(1.0 AS TEXT), CAST('x' AS REAL)")).toEqual([[42, 3, 5, "1.0", 0]]);
    expect(rows("SELECT 'a' || 1 || 2.5 || NULL, 'n=' || 3")).toEqual([[null, "n=3"]]);
  });

  test("scalar functions", () => {
    expect(rows("SELECT abs(-3), abs(-2.5), lower('AbC'), upper('héllo'), length('héllo'), length(NULL)")).toEqual([[3, 2.5, "abc", "HéLLO", 5, null]]);
    expect(rows("SELECT coalesce(NULL, NULL, 3), ifnull(NULL, 'x'), nullif(1, 1), nullif(1, 2), iif(1, 'y', 'n')")).toEqual([[3, "x", null, 1, "y"]]);
    expect(rows("SELECT substr('abcdef', 2, 3), substr('abcdef', -2), substr('abcdef', 0, 2), substr('abc', 2)")).toEqual([["bcd", "ef", "a", "bc"]]);
    expect(rows("SELECT trim('  x  '), ltrim('xxy', 'x'), rtrim('yxx', 'x'), replace('aXbX', 'X', '-'), instr('hello', 'll')")).toEqual([["x", "y", "y", "a-b-", 3]]);
    expect(rows("SELECT round(2.5), round(-2.5), round(3.14159, 2), max(1, 5, 3), min('b', 'a'), max(1, NULL)")).toEqual([[3, -3, 3.14, 5, "a", null]]);
    expect(rows("SELECT typeof(1), typeof(1.0), typeof('x'), typeof(NULL), printf('%05d|%-3s|%.2f', 42, 'ab', 3.14159)")).toEqual([["integer", "real", "text", "null", "00042|ab |3.14"]]);
  });

  test("bind parameters", () => {
    expect(rows("SELECT ? + ?, ?", [1, 2, "x"])).toEqual([[3, "x"]]);
    expect(rows("SELECT :a * $b, @a", { a: 3, b: 4 })).toEqual([[12, 3]]);
    expect(rows("SELECT ?2, ?1", [10, 20])).toEqual([[20, 10]]);
    expect(rows("SELECT ? IS NULL, ?", [null, true])).toEqual([[1, 1]]);
    expect(() => rows("SELECT :missing", {})).toThrow(/missing value/);
  });
});

describe("queries", () => {
  test("WHERE, ORDER BY, LIMIT/OFFSET", () => {
    expect(rows("SELECT name FROM emp WHERE salary >= 90 ORDER BY salary DESC")).toEqual([["ann"], ["bob"], ["cy"]]);
    expect(rows("SELECT name FROM emp ORDER BY salary LIMIT 2")).toEqual([["ed"], ["di"]]);
    expect(rows("SELECT name FROM emp ORDER BY salary DESC LIMIT 2 OFFSET 1")).toEqual([["bob"], ["cy"]]);
    expect(rows("SELECT name FROM emp ORDER BY salary DESC NULLS FIRST LIMIT 1")).toEqual([["ed"]]);
    expect(rows("SELECT name AS n FROM emp ORDER BY n DESC LIMIT 1")).toEqual([["ed"]]);
    expect(rows("SELECT name, salary FROM emp ORDER BY 2 DESC, 1 LIMIT 1")).toEqual([["ann", 120]]);
    expect(rows("SELECT name FROM emp ORDER BY length(name), name DESC LIMIT 3")).toEqual([["ed"], ["di"], ["cy"]]);
    expect(rows("SELECT name FROM emp LIMIT -1 OFFSET 4")).toEqual([["ed"]]);
  });

  test("column naming", () => {
    expect(db.exec("SELECT name, salary * 2, salary AS s, e.dept FROM emp e LIMIT 1").columns).toEqual(["name", "salary * 2", "s", "dept"]);
    expect(db.exec("SELECT * FROM dept LIMIT 0").columns).toEqual(["name", "floor"]);
  });

  test("DISTINCT", () => {
    expect(rows("SELECT DISTINCT dept FROM emp ORDER BY dept")).toEqual([[null], ["eng"], ["ops"]]);
    expect(rows("SELECT DISTINCT 1.0 UNION ALL SELECT DISTINCT 1")).toEqual([[1], [1]]);
  });

  test("GROUP BY with aggregates and HAVING", () => {
    expect(rows("SELECT dept, count(*), count(salary), sum(salary), min(name), max(salary) FROM emp GROUP BY dept ORDER BY dept")).toEqual([
      [null, 1, 1, 70, "di", 70],
      ["eng", 2, 2, 220, "ann", 120],
      ["ops", 2, 1, 90, "cy", 90],
    ]);
    expect(rows("SELECT dept, avg(salary) FROM emp GROUP BY dept HAVING count(*) > 1 ORDER BY 2 DESC")).toEqual([["eng", 110], ["ops", 90]]);
    expect(rows("SELECT dept FROM emp GROUP BY 1 HAVING sum(salary) > 100")).toEqual([["eng"]]);
    expect(rows("SELECT group_concat(name), group_concat(name, '|') FROM emp WHERE dept = 'eng'")).toEqual([["ann,bob", "ann|bob"]]);
    expect(rows("SELECT count(DISTINCT dept), count(DISTINCT manager), total(salary) FROM emp")).toEqual([[2, 2, 380]]);
    expect(rows("SELECT length(name) AS len, count(*) FROM emp GROUP BY len ORDER BY len")).toEqual([[2, 3], [3, 2]]);
  });

  test("aggregates over empty input", () => {
    expect(rows("SELECT count(*), sum(salary), avg(salary), max(salary), total(salary) FROM emp WHERE 0")).toEqual([[0, null, null, null, 0]]);
    expect(rows("SELECT dept, count(*) FROM emp WHERE 0 GROUP BY dept")).toEqual([]);
  });

  test("SELECT without FROM and VALUES", () => {
    expect(rows("SELECT 1, 'two'")).toEqual([[1, "two"]]);
    expect(db.exec("VALUES (1, 'a'), (2, 'b')")).toMatchObject({ columns: ["column1", "column2"], rows: [[1, "a"], [2, "b"]] });
  });

  test("joins", () => {
    expect(rows("SELECT e.name, d.floor FROM emp e JOIN dept d ON e.dept = d.name ORDER BY e.id")).toEqual([
      ["ann", 3], ["bob", 3], ["cy", 1], ["ed", 1],
    ]);
    expect(rows("SELECT e.name, d.floor FROM emp e LEFT JOIN dept d ON e.dept = d.name WHERE d.floor IS NULL")).toEqual([["di", null]]);
    expect(rows("SELECT d.name, count(e.id) FROM dept d LEFT JOIN emp e ON e.dept = d.name GROUP BY d.name ORDER BY d.name")).toEqual([
      ["eng", 2], ["hr", 0], ["ops", 2],
    ]);
    expect(rows("SELECT count(*) FROM emp, dept")).toEqual([[15]]);
    expect(rows("SELECT count(*) FROM emp CROSS JOIN dept WHERE emp.dept = dept.name")).toEqual([[4]]);
    // self join
    expect(rows("SELECT e.name, m.name FROM emp e JOIN emp m ON e.manager = m.id ORDER BY e.id")).toEqual([
      ["bob", "ann"], ["cy", "ann"], ["di", "cy"], ["ed", "cy"],
    ]);
    // non-equi join takes the nested-loop path
    expect(rows("SELECT count(*) FROM emp a JOIN emp b ON a.salary < b.salary")).toEqual([[6]]);
  });

  test("JOIN USING hides the duplicate column", () => {
    db.exec("CREATE TABLE a (k INT, x TEXT); CREATE TABLE b (k INT, y TEXT); INSERT INTO a VALUES (1, 'a1'), (2, 'a2'); INSERT INTO b VALUES (2, 'b2'), (3, 'b3')");
    const r = db.exec("SELECT * FROM a JOIN b USING (k)");
    expect(r.columns).toEqual(["k", "x", "y"]);
    expect(r.rows).toEqual([[2, "a2", "b2"]]);
    expect(rows("SELECT k, b.k FROM a LEFT JOIN b USING (k) ORDER BY k")).toEqual([[1, null], [2, 2]]);
  });

  test("ambiguous and unknown names are errors", () => {
    expect(() => rows("SELECT name FROM emp, dept")).toThrow(/ambiguous column name: name/);
    expect(() => rows("SELECT nope FROM emp")).toThrow(/no such column: nope/);
    expect(() => rows("SELECT * FROM nope")).toThrow(/no such table: nope/);
    expect(() => rows("SELECT x.* FROM emp")).toThrow(/no such table: x/);
    expect(() => rows("SELECT name FROM emp WHERE count(*) > 1")).toThrow(/misuse of aggregate/);
    expect(() => rows("SELECT nosuchfn(1)")).toThrow(/no such function/);
  });

  test("subqueries", () => {
    expect(rows("SELECT name FROM emp WHERE salary > (SELECT avg(salary) FROM emp) ORDER BY name")).toEqual([["ann"], ["bob"]]);
    expect(rows("SELECT name FROM emp WHERE dept IN (SELECT name FROM dept WHERE floor > 2) ORDER BY 1")).toEqual([["ann"], ["bob"]]);
    expect(rows("SELECT name FROM dept d WHERE NOT EXISTS (SELECT 1 FROM emp WHERE dept = d.name)")).toEqual([["hr"]]);
    expect(rows("SELECT t.dept, t.n FROM (SELECT dept, count(*) AS n FROM emp GROUP BY dept) AS t WHERE t.n > 1 ORDER BY 1")).toEqual([["eng", 2], ["ops", 2]]);
    // correlated scalar subquery: rank by salary
    expect(rows("SELECT name, (SELECT count(*) FROM emp e2 WHERE e2.salary > e.salary) FROM emp e WHERE salary IS NOT NULL ORDER BY 2")).toEqual([
      ["ann", 0], ["bob", 1], ["cy", 2], ["di", 3],
    ]);
    expect(rows("SELECT (SELECT name FROM emp WHERE 0)")).toEqual([[null]]);
    expect(() => rows("SELECT 1 IN (SELECT 1, 2)")).toThrow(/2 columns/);
  });

  test("compound selects", () => {
    expect(rows("SELECT dept FROM emp UNION SELECT name FROM dept ORDER BY 1")).toEqual([[null], ["eng"], ["hr"], ["ops"]]);
    expect(rows("SELECT 1 UNION ALL SELECT 1 UNION ALL SELECT 2")).toEqual([[1], [1], [2]]);
    expect(rows("SELECT name FROM dept INTERSECT SELECT dept FROM emp ORDER BY name")).toEqual([["eng"], ["ops"]]);
    expect(rows("SELECT name FROM dept EXCEPT SELECT dept FROM emp")).toEqual([["hr"]]);
    expect(rows("SELECT name FROM dept UNION SELECT 'zz' ORDER BY name DESC LIMIT 2")).toEqual([["zz"], ["ops"]]);
    expect(() => rows("SELECT 1 UNION SELECT 1, 2")).toThrow(/same number of result columns/);
  });
});

describe("DML and constraints", () => {
  test("INTEGER PRIMARY KEY auto-assigns ids", () => {
    const r = db.run("INSERT INTO emp (name) VALUES ('fay')");
    expect(r).toEqual({ changes: 1, lastInsertRowid: 6n });
    db.run("INSERT INTO emp (id, name) VALUES (100, 'gus')");
    expect(db.run("INSERT INTO emp (name) VALUES ('hal')").lastInsertRowid).toBe(101n);
  });

  test("type affinity on insert", () => {
    db.exec("CREATE TABLE t (i INTEGER, r REAL, s TEXT, n NUMERIC, b)");
    db.exec("INSERT INTO t VALUES ('12', '1.5', 34, '5.0', '7')");
    expect(rows("SELECT typeof(i), typeof(r), typeof(s), typeof(n), typeof(b), i, r, s, n FROM t")).toEqual([
      ["integer", "real", "text", "integer", "text", 12, 1.5, "34", 5],
    ]);
  });

  test("UPDATE sees the old row and reports changes", () => {
    db.exec("CREATE TABLE p (a INT, b INT); INSERT INTO p VALUES (1, 2)");
    db.run("UPDATE p SET a = b, b = a");
    expect(rows("SELECT a, b FROM p")).toEqual([[2, 1]]);
    expect(db.run("UPDATE emp SET salary = salary + 10 WHERE dept = 'eng'").changes).toBe(2);
    expect(rows("SELECT sum(salary) FROM emp WHERE dept = 'eng'")).toEqual([[240]]);
  });

  test("DELETE", () => {
    expect(db.run("DELETE FROM emp WHERE salary IS NULL OR salary < 80").changes).toBe(2);
    expect(rows("SELECT count(*) FROM emp")).toEqual([[3]]);
    expect(db.run("DELETE FROM emp").changes).toBe(3);
  });

  test("NOT NULL, UNIQUE and PRIMARY KEY", () => {
    expect(() => db.run("INSERT INTO emp (name) VALUES (NULL)")).toThrow("NOT NULL constraint failed: emp.name");
    expect(() => db.run("INSERT INTO dept VALUES ('eng', 9)")).toThrow("PRIMARY KEY constraint failed: dept.name");
    db.exec("CREATE TABLE u (a INT, b INT, UNIQUE (a, b))");
    db.exec("INSERT INTO u VALUES (1, 1), (1, 2), (1, NULL), (1, NULL)");
    expect(() => db.run("INSERT INTO u VALUES (1, 2)")).toThrow("UNIQUE constraint failed: u.a, u.b");
    expect(() => db.run("UPDATE u SET b = 1")).toThrow(/UNIQUE/);
    expect(rows("SELECT count(*) FROM u WHERE b = 1")).toEqual([[1]]);
  });

  test("statements are atomic", () => {
    expect(() => db.run("INSERT INTO dept VALUES ('new1', 1), ('eng', 2)")).toThrow(SqlError);
    expect(rows("SELECT count(*) FROM dept")).toEqual([[3]]);
    expect(() => db.run("UPDATE emp SET name = NULL WHERE id = 5")).toThrow(/NOT NULL/);
    expect(rows("SELECT name FROM emp WHERE id = 5")).toEqual([["ed"]]);
  });

  test("INSERT OR IGNORE / OR REPLACE", () => {
    expect(db.run("INSERT OR IGNORE INTO dept VALUES ('eng', 9), ('qa', 4)").changes).toBe(1);
    expect(rows("SELECT floor FROM dept WHERE name = 'eng'")).toEqual([[3]]);
    db.run("INSERT OR REPLACE INTO dept VALUES ('eng', 9)");
    expect(rows("SELECT floor FROM dept WHERE name = 'eng'")).toEqual([[9]]);
    expect(rows("SELECT count(*) FROM dept")).toEqual([[4]]);
  });

  test("INSERT ... SELECT, DEFAULT values, CREATE TABLE AS", () => {
    db.exec("CREATE TABLE log (id INTEGER PRIMARY KEY, msg TEXT DEFAULT 'none', level INT DEFAULT 1)");
    db.exec("INSERT INTO log DEFAULT VALUES");
    db.exec("INSERT INTO log (msg) SELECT name FROM emp WHERE dept = 'ops'");
    expect(rows("SELECT * FROM log")).toEqual([[1, "none", 1], [2, "cy", 1], [3, "ed", 1]]);
    db.exec("CREATE TABLE rich AS SELECT name, salary FROM emp WHERE salary > 95");
    expect(rows("SELECT * FROM rich ORDER BY salary")).toEqual([["bob", 100], ["ann", 120]]);
  });

  test("DDL errors", () => {
    expect(() => db.exec("CREATE TABLE emp (x)")).toThrow(/already exists/);
    db.exec("CREATE TABLE IF NOT EXISTS emp (x)");
    expect(() => db.exec("CREATE TABLE d (a, A)")).toThrow(/duplicate column/);
    db.exec("DROP TABLE dept");
    expect(db.tableNames()).toEqual(["emp"]);
    db.exec("DROP TABLE IF EXISTS dept");
    expect(() => db.exec("DROP TABLE dept")).toThrow(/no such table/);
  });

  test("identifiers are case-insensitive", () => {
    expect(rows("select NAME from EMP where ID = 1")).toEqual([["ann"]]);
  });
});

describe("transactions", () => {
  test("rollback restores data and schema", () => {
    db.exec("BEGIN");
    expect(db.inTransaction).toBe(true);
    db.exec("DELETE FROM emp; DROP TABLE dept; CREATE TABLE tmp (x)");
    db.exec("ROLLBACK");
    expect(db.inTransaction).toBe(false);
    expect(rows("SELECT count(*) FROM emp")).toEqual([[5]]);
    expect(db.tableNames()).toEqual(["dept", "emp"]);
    // constraint indexes are restored too
    expect(() => db.run("INSERT INTO dept VALUES ('eng', 1)")).toThrow(/PRIMARY KEY/);
  });

  test("commit keeps changes", () => {
    db.exec("BEGIN; INSERT INTO dept VALUES ('qa', 5); COMMIT");
    expect(rows("SELECT count(*) FROM dept")).toEqual([[4]]);
  });

  test("a failed statement does not abort the transaction", () => {
    db.exec("BEGIN; INSERT INTO dept VALUES ('qa', 5)");
    expect(() => db.exec("INSERT INTO dept VALUES ('qa', 6)")).toThrow();
    db.exec("COMMIT");
    expect(rows("SELECT floor FROM dept WHERE name = 'qa'")).toEqual([[5]]);
  });

  test("misuse", () => {
    expect(() => db.exec("COMMIT")).toThrow(/no transaction/);
    expect(() => db.exec("ROLLBACK")).toThrow(/no transaction/);
    db.exec("BEGIN");
    expect(() => db.exec("BEGIN")).toThrow(/within a transaction/);
  });
});

describe("API", () => {
  test("query/get return objects", () => {
    expect(db.get("SELECT name, salary FROM emp WHERE id = ?", [2])).toEqual({ name: "bob", salary: 100 });
    expect(db.get("SELECT 1 WHERE 0")).toBeUndefined();
    expect(db.query("SELECT id FROM emp WHERE dept = :d", { d: "ops" })).toEqual([{ id: 3 }, { id: 5 }]);
  });

  test("schema() reconstructs DDL", () => {
    db.exec("CREATE TABLE s (a INTEGER PRIMARY KEY, b TEXT NOT NULL UNIQUE, c REAL, UNIQUE (b, c))");
    expect(db.schema("s")).toBe("CREATE TABLE s (\n  a INTEGER PRIMARY KEY,\n  b TEXT NOT NULL UNIQUE,\n  c REAL,\n  UNIQUE (b, c)\n);");
  });

  test("execute returns every statement's result", () => {
    const results = db.execute("SELECT 1; SELECT 2, 3");
    expect(results.map((r) => r.rows)).toEqual([[[1n]], [[2n, 3n]]]);
  });

  test("hash join handles thousands of rows quickly", () => {
    db.exec("CREATE TABLE l (k INT, v INT); CREATE TABLE r (k INT, w INT)");
    for (let i = 0; i < 3000; i++) db.run("INSERT INTO l VALUES (?, ?)", [i, i * 2]);
    for (let i = 0; i < 3000; i += 3) db.run("INSERT INTO r VALUES (?, ?)", [i, i]);
    const t0 = performance.now();
    expect(one("SELECT count(*) FROM l JOIN r ON l.k = r.k AND r.w >= 0")).toBe(1000);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
