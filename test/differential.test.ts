/**
 * Differential fuzzing: generate random schemas, data, queries and DML from a
 * seeded PRNG, run them on both minisql and SQLite (bun:sqlite), and require
 * identical results. The generator sticks to the part of SQLite's semantics
 * minisql implements (integer columns, text compared only with text, ...).
 */
import { Database as Sqlite } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "../src/index";

/** mulberry32: tiny deterministic PRNG so failures are reproducible from the seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof rng>;

const WORDS = ["apple", "Apple", "banana", "cherry", "date", "fig", "grape", "", "a_b", "50%"];

function setup(r: Rng): string {
  const intOrNull = () => (r.chance(0.15) ? "NULL" : String(r.int(-6, 6)));
  const textOrNull = () => (r.chance(0.15) ? "NULL" : `'${r.pick(WORDS)}'`);
  const t1 = Array.from({ length: r.int(0, 14) }, () => `(${intOrNull()}, ${intOrNull()}, ${textOrNull()})`);
  const t2 = Array.from({ length: r.int(0, 10) }, () => `(${intOrNull()}, ${intOrNull()})`);
  let sql = "CREATE TABLE t1 (a INTEGER, b INTEGER, c TEXT); CREATE TABLE t2 (a INTEGER, d INTEGER);";
  if (t1.length) sql += `INSERT INTO t1 VALUES ${t1.join(", ")};`;
  if (t2.length) sql += `INSERT INTO t2 VALUES ${t2.join(", ")};`;
  return sql;
}

/** Random integer-valued expression over the given columns. */
function intExpr(r: Rng, cols: string[], depth = 0): string {
  const leaf = () =>
    r.chance(0.65) ? r.pick(cols) : r.chance(0.1) ? "NULL" : r.chance(0.12) ? r.pick(["2.5", "0.5", "-1.5", "3.0"]) : String(r.int(-4, 7));
  if (depth >= 2 || r.chance(0.4)) return leaf();
  switch (r.int(0, 6)) {
    case 0:
    case 1:
    case 2:
      return `(${intExpr(r, cols, depth + 1)} ${r.pick(["+", "-", "*", "/", "%"])} ${intExpr(r, cols, depth + 1)})`;
    case 3:
      return `abs(${intExpr(r, cols, depth + 1)})`;
    case 4:
      return `coalesce(${intExpr(r, cols, depth + 1)}, ${r.int(-3, 3)})`;
    case 5:
      return `CASE WHEN ${pred(r, cols, depth + 1)} THEN ${intExpr(r, cols, depth + 1)} ELSE ${intExpr(r, cols, depth + 1)} END`;
    default:
      return `-(${intExpr(r, cols, depth + 1)})`;
  }
}

/** Random predicate. `textCols` may be compared with LIKE / text literals only. */
function pred(r: Rng, cols: string[], depth = 0, textCols: string[] = []): string {
  if (depth < 2 && r.chance(0.3)) {
    const op = r.pick(["AND", "OR"]);
    return `(${pred(r, cols, depth + 1, textCols)} ${op} ${pred(r, cols, depth + 1, textCols)})`;
  }
  if (depth < 2 && r.chance(0.1)) return `NOT ${pred(r, cols, depth + 1, textCols)}`;
  const e = () => intExpr(r, cols, depth + 1);
  switch (r.int(0, textCols.length ? 6 : 4)) {
    case 0:
    case 1:
      return `${e()} ${r.pick(["=", "<>", "<", "<=", ">", ">="])} ${e()}`;
    case 2:
      return `${e()} IS ${r.chance(0.5) ? "NOT " : ""}NULL`;
    case 3:
      return `${e()} ${r.chance(0.3) ? "NOT " : ""}IN (${Array.from({ length: r.int(1, 4) }, () => (r.chance(0.15) ? "NULL" : r.int(-4, 4))).join(", ")})`;
    case 4:
      return `${e()} ${r.chance(0.3) ? "NOT " : ""}BETWEEN ${e()} AND ${e()}`;
    case 5:
      return `${r.pick(textCols)} ${r.chance(0.3) ? "NOT " : ""}LIKE '${r.pick(["a%", "%an%", "_ig", "%", "%e", "A%", "%\\%%"])}'${r.chance(0.2) ? " ESCAPE '\\'" : ""}`;
    default:
      return `${r.pick(textCols)} ${r.pick(["=", "<>", "<", ">="])} '${r.pick(WORDS)}'`;
  }
}

let orderRng: Rng | undefined;
function orderAll(n: number): string {
  // every output column participates, each ASC or DESC, so the order is total
  const dir = () => (orderRng && orderRng.chance(0.3) ? " DESC" : "");
  return ` ORDER BY ${Array.from({ length: n }, (_, i) => `${i + 1}${dir()}`).join(", ")}`;
}

/** Random text-valued expression over column c. */
function textExpr(r: Rng): string {
  return r.pick([
    "c", "lower(c)", "upper(c)", "c || '-' || a", "a || c", "substr(c, 2)", `substr(c, ${r.int(-3, 3)}, ${r.int(-2, 3)})`,
    "replace(c, 'a', 'A')", "trim(c, 'a')", "ltrim(c, 'ab')", "rtrim(c, 'e')", "coalesce(c, 'none')", "ifnull(c, a)",
    "CAST(a AS TEXT)", "CAST(c AS INTEGER)", "typeof(a / 2.0)", "typeof(c)", "nullif(c, 'fig')", "instr(c, 'an')",
    "length(c)", "CASE c WHEN 'fig' THEN 1 WHEN 'date' THEN 2 END", "printf('%d:%s', a, c)", "round(a / 3.0, 2)",
    "max(a, b)", "min(a, b, 0)", "a & b", "a | b", "a << 2", "b >> 1", "~a", "sign(b)",
  ]);
}

function genQuery(r: Rng): string {
  const t1cols = ["a", "b"];
  orderRng = r;
  switch (r.int(0, 9)) {
    case 0: {
      // projection + filter
      const items = Array.from({ length: r.int(1, 3) }, () => intExpr(r, t1cols));
      if (r.chance(0.5)) items.push(textExpr(r));
      return `SELECT ${r.chance(0.2) ? "DISTINCT " : ""}${items.join(", ")} FROM t1 WHERE ${pred(r, t1cols, 0, ["c"])}${orderAll(items.length)}${r.chance(0.3) ? ` LIMIT ${r.int(0, 5)} OFFSET ${r.int(0, 3)}` : ""}`;
    }
    case 1: {
      // grouping
      const key = r.pick(["a", "b", "a % 3", "c"]);
      const aggs = Array.from({ length: r.int(1, 3) }, () =>
        r.pick([
          "count(*)", `count(${r.pick(t1cols)})`, `sum(${intExpr(r, t1cols)})`, `min(${intExpr(r, t1cols)})`,
          `max(${intExpr(r, t1cols)})`, `avg(${r.pick(t1cols)})`, `count(DISTINCT ${r.pick(t1cols)})`, `total(${r.pick(t1cols)})`,
        ]),
      );
      const having = r.chance(0.4) ? ` HAVING count(*) ${r.pick([">", ">=", "<"])} ${r.int(0, 3)}` : "";
      const where = r.chance(0.5) ? ` WHERE ${pred(r, t1cols)}` : "";
      return `SELECT ${key}, ${aggs.join(", ")} FROM t1${where} GROUP BY ${key}${having}${orderAll(aggs.length + 1)}`;
    }
    case 2: {
      // whole-table aggregate (also exercises the empty-input row)
      const aggs = Array.from({ length: r.int(1, 3) }, () => r.pick(["count(*)", "sum(b)", "max(a)", "min(b)", "avg(a)", "group_concat(c)"]));
      return `SELECT ${aggs.join(", ")} FROM t1 WHERE ${pred(r, t1cols)}`;
    }
    case 3: {
      // joins
      const type = r.pick(["JOIN", "LEFT JOIN"]);
      const cols = ["t1.a", "t1.b", "t2.a", "t2.d"];
      const on = r.chance(0.7) ? `t1.a = t2.a${r.chance(0.3) ? ` AND ${pred(r, cols)}` : ""}` : pred(r, cols);
      const where = r.chance(0.5) ? ` WHERE ${pred(r, cols)}` : "";
      return `SELECT t1.a, t1.b, t2.d FROM t1 ${type} t2 ON ${on}${where}${orderAll(3)}`;
    }
    case 4: {
      // IN / EXISTS / scalar subqueries, possibly correlated
      const sub = r.pick([
        `t1.a ${r.chance(0.3) ? "NOT " : ""}IN (SELECT a FROM t2 WHERE ${pred(r, ["a", "d"])})`,
        `${r.chance(0.3) ? "NOT " : ""}EXISTS (SELECT 1 FROM t2 WHERE t2.a = t1.b AND ${pred(r, ["t2.d", "t1.a"])})`,
        `t1.b ${r.pick(["<", ">=", "="])} (SELECT ${r.pick(["max(d)", "min(a)", "count(*)", "sum(d)"])} FROM t2 WHERE t2.a ${r.pick(["<", "=", "<>"])} t1.a)`,
      ]);
      return `SELECT a, b FROM t1 WHERE ${sub}${orderAll(2)}`;
    }
    case 5: {
      // compound
      const op = r.pick(["UNION", "UNION ALL", "INTERSECT", "EXCEPT"]);
      return `SELECT ${intExpr(r, ["a", "b"])} FROM t1 WHERE ${pred(r, ["a", "b"])} ${op} SELECT ${r.pick(["a", "d", "a + d"])} FROM t2 ORDER BY 1`;
    }
    case 6: {
      // derived table
      return `SELECT x, count(*) FROM (SELECT ${intExpr(r, t1cols)} AS x FROM t1 WHERE ${pred(r, t1cols)}) AS s GROUP BY x ORDER BY 1, 2`;
    }
    case 7: {
      // scalar select-list subquery, correlated
      return `SELECT a, (SELECT count(*) FROM t2 WHERE t2.d ${r.pick(["<", ">", "="])} t1.b) FROM t1${orderAll(2)}`;
    }
    case 8: {
      // three-way joins and USING
      const cols = ["x.a", "x.b", "y.d", "z.d"];
      const first = r.chance(0.5) ? "t1 x JOIN t2 y USING (a)" : `t1 x ${r.pick(["JOIN", "LEFT JOIN"])} t2 y ON x.b = y.a`;
      return `SELECT x.a, x.b, y.d, z.d FROM ${first} ${r.pick(["JOIN", "LEFT JOIN"])} t2 z ON z.a = y.d WHERE ${pred(r, cols)}${orderAll(4)}`;
    }
    default: {
      // group_concat and ordering by expressions that are not selected
      return `SELECT a, group_concat(c, '/') FROM (SELECT a, c FROM t1 WHERE c IS NOT NULL ORDER BY c) GROUP BY a ORDER BY a${r.chance(0.5) ? " DESC" : ""}`;
    }
  }
}

function genDml(r: Rng): string {
  const t1cols = ["a", "b"];
  switch (r.int(0, 3)) {
    case 0:
      return `UPDATE t1 SET ${r.pick(t1cols)} = ${intExpr(r, t1cols)} WHERE ${pred(r, t1cols, 0, ["c"])}`;
    case 1:
      return `DELETE FROM t1 WHERE ${pred(r, t1cols, 0, ["c"])}`;
    case 2:
      return `INSERT INTO t1 (a, b) SELECT ${intExpr(r, ["a", "d"])}, d FROM t2 WHERE ${pred(r, ["a", "d"])}`;
    default:
      return `INSERT INTO t2 SELECT b, a FROM t1 WHERE ${pred(r, t1cols)}`;
  }
}

/**
 * Normalise results so REAL rounding noise does not count as a mismatch. -0.0 is
 * folded into 0 because SQLite itself is inconsistent about the sign of zero
 * (`-(0.0)` is -0.0 but `-(4 % 2.5)` is 0.0, an artefact of its IntReal storage).
 */
function norm(rows: unknown[][]): unknown[][] {
  return rows.map((row) =>
    row.map((v) => {
      if (typeof v === "bigint") return Number(v);
      if (typeof v !== "number") return v;
      if (Object.is(v, -0)) return 0;
      return Number.isInteger(v) ? v : Math.round(v * 1e9) / 1e9;
    }),
  );
}

function runBoth(seed: number, statements: number, gen: (r: Rng) => string, dumpAfter = false) {
  const r = rng(seed);
  const schema = setup(r);
  const lite = new Sqlite(":memory:");
  lite.exec(schema);
  const mini = new Database();
  mini.exec(schema);
  for (let i = 0; i < statements; i++) {
    const sql = gen(r);
    const ctx = `seed ${seed}, statement ${i}: ${sql}`;
    let expected: unknown[][] | Error;
    try {
      expected = norm((lite.query(sql).values() ?? []) as unknown[][]);
    } catch (e) {
      expected = e as Error;
      if (process.env.FUZZ_STATS && stats.error < 5) console.log("sqlite error:", expected.message, "|", sql);
    }
    let actual: unknown[][] | Error;
    try {
      actual = norm(mini.exec(sql).rows);
    } catch (e) {
      actual = e as Error;
    }
    if (process.env.FUZZ_STATS) stats[expected instanceof Error ? "error" : (expected as unknown[][]).length ? "rows" : "empty"]++;
    if (expected instanceof Error || actual instanceof Error) {
      // both must fail, or neither
      expect({ ctx, failed: actual instanceof Error }).toEqual({ ctx, failed: expected instanceof Error });
      continue;
    }
    expect({ ctx, rows: actual }).toEqual({ ctx, rows: expected });
    if (dumpAfter) {
      for (const t of ["t1", "t2"]) {
        const q = `SELECT * FROM ${t} ORDER BY 1, 2`;
        expect({ ctx, t, rows: norm(mini.exec(q).rows) }).toEqual({ ctx, t, rows: norm(lite.query(q).values() as unknown[][]) });
      }
    }
  }
  lite.close();
}

const stats = { error: 0, rows: 0, empty: 0 };
afterAll(() => {
  if (process.env.FUZZ_STATS) console.log("fuzz outcomes:", stats);
});
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 150);

describe("differential testing against SQLite", () => {
  test(`random queries (${SEEDS} seeds x 25 queries)`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) runBoth(seed, 25, genQuery);
  });

  test(`random DML sequences (${SEEDS} seeds x 8 statements)`, () => {
    for (let seed = 10_001; seed <= 10_000 + SEEDS; seed++) runBoth(seed, 8, genDml, true);
  });
});
