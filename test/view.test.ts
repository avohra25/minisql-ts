import { beforeEach, describe, expect, test } from "bun:test";
import { Database, Shell } from "../src/index";
import { parseStatement } from "../src/parser";

let db: Database;
const rows = (sql: string) => db.exec(sql).rows;

beforeEach(() => {
  db = new Database();
  db.exec(`
    CREATE TABLE t (a INT, b TEXT);
    INSERT INTO t VALUES (1, 'x'), (2, 'y'), (3, NULL);
    CREATE VIEW v AS SELECT a, b FROM t WHERE a > 1;
  `);
});

describe("views", () => {
  test("parse", () => {
    const s = parseStatement("CREATE VIEW IF NOT EXISTS w (k, n) AS SELECT b, count(*) FROM t GROUP BY b");
    expect(s).toMatchObject({ kind: "createView", name: "w", ifNotExists: true, columns: ["k", "n"] });
    expect(s.kind === "createView" && s.sql).toBe("CREATE VIEW IF NOT EXISTS w (k, n) AS SELECT b, count(*) FROM t GROUP BY b");
    expect(parseStatement("DROP VIEW IF EXISTS w")).toEqual({ kind: "dropView", name: "w", ifExists: true });
    // VIEW is not reserved
    expect(new Database().exec("SELECT 1 AS view").columns).toEqual(["view"]);
  });

  test("query like a table, always current", () => {
    expect(rows("SELECT * FROM v ORDER BY a")).toEqual([[2, "y"], [3, null]]);
    db.exec("INSERT INTO t VALUES (9, 'z')");
    expect(rows("SELECT a FROM v ORDER BY a").flat()).toEqual([2, 3, 9]);
    expect(rows("SELECT v.a, x.a FROM v JOIN v AS x ON x.a = v.a + 1")).toEqual([[2, 3]]);
    expect(rows("SELECT (SELECT count(*) FROM v WHERE v.a >= t.a) FROM t ORDER BY 1").flat()).toEqual([1, 2, 3, 3]);
  });

  test("column lists, views on views, and WITH inside a view", () => {
    db.exec("CREATE VIEW counts (k, n) AS SELECT b, count(*) FROM t GROUP BY b");
    db.exec("CREATE VIEW big AS SELECT k FROM counts WHERE n >= 1 AND k IS NOT NULL");
    db.exec("CREATE VIEW nums AS WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 4) SELECT i FROM c");
    expect(rows("SELECT * FROM counts ORDER BY k")).toEqual([[null, 1], ["x", 1], ["y", 1]]);
    expect(rows("SELECT k FROM big ORDER BY k").flat()).toEqual(["x", "y"]);
    expect(rows("SELECT sum(i) FROM nums")).toEqual([[10]]);
  });

  test("a view doesn't see the caller's CTEs, but a CTE can hide a view", () => {
    expect(rows("WITH t(a, b) AS (SELECT 100, 'z') SELECT a FROM v ORDER BY a").flat()).toEqual([2, 3]);
    expect(rows("WITH v(a) AS (SELECT 7) SELECT * FROM v")).toEqual([[7]]);
  });

  test("errors match SQLite", () => {
    const err = (sql: string, msg: string) => expect(() => rows(sql)).toThrow(msg);
    err("CREATE VIEW v AS SELECT 1", "view v already exists");
    expect(() => rows("CREATE VIEW IF NOT EXISTS v AS SELECT 1")).not.toThrow();
    err("CREATE VIEW t AS SELECT 1", "table t already exists");
    err("CREATE TABLE v (x)", "view v already exists");
    err("INSERT INTO v VALUES (5, 'q')", "cannot modify v because it is a view");
    err("UPDATE v SET a = 1", "cannot modify v because it is a view");
    err("DELETE FROM v", "cannot modify v because it is a view");
    err("DROP TABLE v", "use DROP VIEW to delete view v");
    err("DROP VIEW t", "use DROP TABLE to delete table t");
    err("DROP VIEW nope", "no such view: nope");
    expect(() => rows("DROP VIEW IF EXISTS nope")).not.toThrow();
    // problems in the query show up when the view is used, not when it's created
    db.exec("CREATE VIEW b1 AS SELECT * FROM nope; CREATE VIEW b2 (a, b) AS SELECT 1; CREATE VIEW s AS SELECT * FROM s");
    err("SELECT * FROM b1", "no such table: nope");
    err("SELECT * FROM b2", "expected 2 columns for 'b2' but got 1");
    err("SELECT * FROM s", "view s is circularly defined");
  });

  test("DROP VIEW, and transactions roll views back", () => {
    db.exec("DROP VIEW v");
    expect(() => rows("SELECT * FROM v")).toThrow("no such table: v");
    db.exec("CREATE VIEW keep AS SELECT 1 AS one");
    db.exec("BEGIN; CREATE VIEW gone AS SELECT 2; DROP VIEW keep; ROLLBACK");
    expect(db.viewNames()).toEqual(["keep"]);
    db.exec("BEGIN; CREATE VIEW stays AS SELECT 3; COMMIT");
    expect(db.viewNames()).toEqual(["keep", "stays"]);
  });

  test(".tables and .schema include views", () => {
    const sh = new Shell();
    sh.runScript("CREATE TABLE t (a INT); CREATE VIEW  w AS  SELECT a FROM t; CREATE VIEW c AS SELECT 1;");
    expect(sh.feed(".tables")).toBe("c  t  w");
    expect(sh.feed(".schema w")).toBe("CREATE VIEW  w AS  SELECT a FROM t;");
    expect(sh.db.tableNames()).toEqual(["t"]);
  });
});
