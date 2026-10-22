# minisql-ts

An in-memory SQL database engine written from scratch in TypeScript for [Bun](https://bun.sh), with no runtime dependencies. It has a hand-written tokenizer and recursive-descent parser, an executor with SQLite-compatible semantics, constraints and transactions, and an interactive shell. A seeded differential fuzzer checks it against SQLite.

```
$ bun src/cli.ts
minisql - an in-memory SQL engine. Type ".help" for help.
minisql> CREATE TABLE emp (id INTEGER PRIMARY KEY, name TEXT NOT NULL, dept TEXT, salary INT);
minisql> INSERT INTO emp (name, dept, salary) VALUES
   ...>   ('ann', 'eng', 120), ('bob', 'eng', 100), ('cy', 'ops', 90), ('di', NULL, 70);
(4 rows affected)
minisql> SELECT coalesce(dept, '-') AS dept, count(*) AS n, avg(salary) AS avg
   ...> FROM emp GROUP BY dept ORDER BY avg DESC;
┌──────┬───┬───────┐
│ dept │ n │ avg   │
├──────┼───┼───────┤
│ eng  │ 2 │ 110.0 │
│ ops  │ 1 │  90.0 │
│ -    │ 1 │  70.0 │
└──────┴───┴───────┘
(3 rows)
```

## Features

- **Queries:** `SELECT` with `DISTINCT`, `WHERE`, `GROUP BY` and `HAVING`, `ORDER BY` (by expression, alias or position, `NULLS FIRST/LAST`), `LIMIT`/`OFFSET`, and `SELECT` without `FROM`. Also `VALUES (...), (...)` lists.
- **Joins:** `INNER`, `LEFT [OUTER]` and `CROSS` joins, comma joins, `ON` and `USING`. An equality between a left and a right column turns the join into a hash join.
- **Subqueries:** scalar subqueries, `IN (SELECT ...)`, `[NOT] EXISTS`, and derived tables in `FROM`, correlated or not. A subquery that never reads the outer row is detected at runtime and cached for the rest of the statement.
- **Set operations:** `UNION`, `UNION ALL`, `INTERSECT` and `EXCEPT`.
- **Expressions:** arithmetic, `||`, bitwise operators, comparisons, `AND`/`OR`/`NOT` with three-valued logic, `IS [NOT]`, `[NOT] BETWEEN`, `[NOT] IN (...)`, `[NOT] LIKE ... [ESCAPE]`, `CASE`, `CAST`, and `?`, `?N`, `:name`, `@name` and `$name` parameters.
- **Functions:** `abs`, `coalesce`, `ifnull`, `nullif`, `iif`, `length`, `lower`, `upper`, `substr`, `trim`/`ltrim`/`rtrim`, `replace`, `instr`, `round`, `sign`, `typeof`, `printf`, `concat`, and scalar `min`/`max`. Aggregates are `count(*)`, `count`, `sum`, `total`, `avg`, `min`, `max` and `group_concat`, each also with `DISTINCT`.
- **DDL and DML:** `CREATE TABLE [IF NOT EXISTS]` (including `AS SELECT`), `DROP TABLE [IF EXISTS]`, `INSERT` (`VALUES`, `SELECT`, `DEFAULT VALUES`, `OR IGNORE`, `OR REPLACE`), `UPDATE` and `DELETE`.
- **Constraints:** `PRIMARY KEY`, `UNIQUE` (column or table level, multi-column), `NOT NULL` and `DEFAULT`. `INTEGER PRIMARY KEY` columns auto-assign ids like SQLite rowids.
- **Transactions:** `BEGIN`, `COMMIT` and `ROLLBACK` (which restores both data and schema). Each statement is atomic, so a constraint failure halfway through a multi-row `INSERT` changes nothing.

## SQLite-compatible semantics

The engine follows SQLite's rules where it matters for real queries:

- **INTEGER vs REAL.** Integers are `bigint`s internally, so arithmetic is exact over the full 64-bit range, `7 / 2` is `3`, `7.0 / 2` is `3.5`, and integer overflow falls back to REAL. Division or modulo by zero gives `NULL`.
- **NULL.** `NULL` propagates through operators. `AND`/`OR` use three-valued logic, and `x NOT IN (1, NULL)` is `NULL`, not true. Aggregates skip NULLs, and `sum` of nothing is `NULL` while `total` of nothing is `0.0`.
- **Ordering.** Values sort as NULL, then numbers, then text. `1` and `1.0` are equal for `DISTINCT`, `GROUP BY`, `UNIQUE` and set operations.
- **Type affinity.** A column's declared type decides how stored values are coerced, using SQLite's substring rules. Inserting `'12'` into an `INTEGER` column stores the integer 12, and `34` into a `TEXT` column stores `'34'`.
- **Names.** Identifiers are case-insensitive. Unqualified ambiguous columns are an error, and result columns are named after their alias, their column, or the source text of the expression.

## Library use

```ts
import { Database } from "./src/index";

const db = new Database();
db.exec(`CREATE TABLE kv (k TEXT PRIMARY KEY, v INT);
         INSERT INTO kv VALUES ('a', 1), ('b', 2)`);

db.query("SELECT * FROM kv WHERE v > ?", [1]);   // [{ k: "b", v: 2 }]
db.get("SELECT sum(v) AS total FROM kv");       // { total: 3 }
db.run("UPDATE kv SET v = v * 10 WHERE k = :k", { k: "a" }); // { changes: 1, lastInsertRowid: undefined }
db.execute("SELECT 1; SELECT 2");               // raw results for every statement
```

Integers come back as JS numbers when they fit exactly. Pass `new Database({ safeIntegers: true })` to always get `bigint`s.

## Shell

```sh
bun src/cli.ts                  # interactive REPL
bun src/cli.ts schema.sql       # run a script, then drop into the REPL
bun src/cli.ts -m csv -c "SELECT 1 AS one"
cat queries.sql | bun src/cli.ts
```

Dot commands are `.tables`, `.schema [table]`, `.mode table|csv|json`, `.timer on|off`, `.read FILE`, `.help` and `.quit`.

## How it works

| File | Role |
|---|---|
| `src/lexer.ts` | Tokenizer: strings with `''` escapes, quoted identifiers, numbers (including hex), parameters and comments. Every token keeps its source offsets for error messages and column names. |
| `src/parser.ts` | Recursive-descent parser producing the AST in `src/ast.ts`, with SQLite's operator precedence. |
| `src/values.ts` | Value model, comparison and ordering, affinity, `CAST`, and hashing keys for grouping and uniqueness. |
| `src/executor.ts` | Expression evaluator and the `SELECT` pipeline: FROM and joins, then WHERE, grouping, HAVING, projection, DISTINCT, compound operators, ORDER BY and LIMIT. |
| `src/functions.ts` | Scalar functions, aggregates and `LIKE`. |
| `src/database.ts` | Tables, constraint indexes, DML, DDL, transactions and the public API. |
| `src/shell.ts`, `src/format.ts`, `src/cli.ts` | REPL logic (kept free of I/O so it is unit tested), output formatting, and the terminal front end. |

Rows are immutable arrays, which keeps transactions cheap. `BEGIN` snapshots each table by copying its array of row references, and `UPDATE` writes new row arrays instead of mutating old ones.

Expressions are evaluated against a scope chain. Each scope holds the current row and, in aggregate queries, the rows of the current group, and a correlated subquery simply sees the outer row through its parent scope. When a subquery runs, a probe scope sits between it and the outer query. If no name lookup ever passes through the probe, the subquery doesn't depend on the outer row, so its result is cached for the rest of the statement.

## Testing

```sh
bun install
bun test               # about 70 unit tests plus the differential fuzzer
bun run typecheck      # tsc --noEmit, strict mode
FUZZ_SEEDS=20000 bun test --timeout 0 test/differential.test.ts   # a much longer fuzz run
```

`test/differential.test.ts` builds random tables (with NULLs), queries and `UPDATE`/`DELETE`/`INSERT ... SELECT` sequences from a seeded PRNG. It runs each one on both minisql and SQLite through `bun:sqlite` and requires identical results, or an error from both. The generated statements cover filters, grouping, joins (including three-way and `USING`), correlated subqueries, set operations, derived tables, text functions and mixed INTEGER/REAL arithmetic. A failure prints the seed and the exact SQL, so it reproduces every time. The default run checks about 5,000 statements, and a 20,000-seed run (over 600,000 statements) also passes.

## Limitations

This is an in-memory engine for learning and testing, not a replacement for SQLite. It has no persistence, no secondary indexes or query planner beyond the hash join, no window functions, CTEs, views, triggers, `ALTER TABLE` or BLOBs, and no `CHECK` or foreign-key enforcement. Uniqueness checks use hash maps, but `UPDATE` and `DELETE` rebuild them, so each of those statements is O(table size).

## License

MIT
