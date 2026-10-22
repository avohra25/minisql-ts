import { describe, expect, test } from "bun:test";
import { formatCsv, formatJson, formatTable } from "../src/format";
import { Shell, isComplete } from "../src/shell";

describe("formatting", () => {
  test("box table right-aligns numbers and shows NULL", () => {
    expect(formatTable(["name", "n"], [["ann", 120n], ["bob", null], ["c", 1.5]])).toBe(
      [
        "┌──────┬──────┐",
        "│ name │ n    │",
        "├──────┼──────┤",
        "│ ann  │  120 │",
        "│ bob  │ NULL │",
        "│ c    │  1.5 │",
        "└──────┴──────┘",
      ].join("\n"),
    );
  });

  test("csv quoting and json", () => {
    expect(formatCsv(["a", "b"], [["x,y", null], ['say "hi"', 2n], ["z", 3.0]])).toBe('a,b\n"x,y",\n"say ""hi""",2\nz,3.0');
    expect(JSON.parse(formatJson(["a"], [[1n], [null], [9223372036854775807n]]))).toEqual([{ a: 1 }, { a: null }, { a: "9223372036854775807" }]);
  });
});

describe("shell", () => {
  test("statement completeness", () => {
    expect(isComplete("SELECT 1;")).toBe(true);
    expect(isComplete("SELECT 1")).toBe(false);
    expect(isComplete("SELECT ';")).toBe(false);
    expect(isComplete("SELECT 1 -- done;")).toBe(false);
    expect(isComplete("SELECT #;")).toBe(true); // a lexer error is reported straight away
  });

  test("multi-line statements and row counts", () => {
    const sh = new Shell();
    expect(sh.feed("CREATE TABLE t (a INT);")).toBe("");
    expect(sh.feed("INSERT INTO t VALUES (1), (2);")).toBe("(2 rows affected)");
    expect(sh.feed("SELECT a,")).toBe("");
    expect(sh.prompt).toBe("   ...> ");
    expect(sh.feed("a * 10 AS b FROM t;")).toBe(
      ["┌───┬────┐", "│ a │ b  │", "├───┼────┤", "│ 1 │ 10 │", "│ 2 │ 20 │", "└───┴────┘", "(2 rows)"].join("\n"),
    );
    expect(sh.prompt).toBe("minisql> ");
  });

  test("errors are reported, not thrown", () => {
    const sh = new Shell();
    expect(sh.feed("SELECT * FROM nope;")).toBe("Error: no such table: nope");
    expect(sh.feed("SELEC 1;")).toMatch(/^Error: expected a statement/);
  });

  test("dot commands", () => {
    const files: Record<string, string> = { "seed.sql": "CREATE TABLE b (x INT PRIMARY KEY);\nCREATE TABLE a (y TEXT);\nINSERT INTO b VALUES (7);" };
    const sh = new Shell({ readFile: (p) => files[p]!, now: () => 0 });
    expect(sh.feed(".read seed.sql")).toBe("(1 row affected)");
    expect(sh.feed(".tables")).toBe("a  b");
    expect(sh.feed(".schema b")).toBe("CREATE TABLE b (\n  x INT PRIMARY KEY\n);");
    expect(sh.feed(".mode csv")).toBe("");
    expect(sh.feed("SELECT x, 'q' FROM b;")).toBe("x,'q'\n7,q");
    expect(sh.feed(".mode json")).toBe("");
    expect(JSON.parse(sh.feed("SELECT x FROM b;"))).toEqual([{ x: 7 }]);
    expect(sh.feed(".timer on")).toBe("");
    expect(sh.feed("DELETE FROM b;")).toBe("(1 row affected)\nRun time: 0.000 ms");
    expect(sh.feed(".bogus")).toMatch(/unknown command/);
    expect(sh.feed(".help")).toMatch(/Dot commands/);
    sh.feed(".quit");
    expect(sh.done).toBe(true);
  });

  test("runScript handles a trailing statement without ';'", () => {
    const sh = new Shell();
    sh.feed(".mode csv");
    expect(sh.runScript("SELECT 1 AS one;\nSELECT 2 AS two")).toBe("one\n1\ntwo\n2");
  });
});
