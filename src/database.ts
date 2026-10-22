/**
 * Tables, DML/DDL execution, transactions and the public `Database` API.
 */
import type { ColumnDef, CreateTableStmt, Expr, InsertStmt, Statement } from "./ast";
import {
  evaluate, executeSelect, type Catalog, type ExecContext, type Params, type Scope,
} from "./executor";
import { parse } from "./parser";
import { SqlError, affinityOf, applyAffinity, keyOf, truthy, type Affinity, type Value } from "./values";

export interface Column {
  name: string;
  type: string;
  affinity: Affinity;
  notNull: boolean;
  default?: Expr;
}

interface UniqueConstraint {
  columns: number[];
  /** Keys present in the table (rows with a NULL in the key never conflict). */
  keys: Map<string, Value[]>;
  primary: boolean;
}

export class Table {
  rows: Value[][] = [];
  readonly uniques: UniqueConstraint[] = [];
  /** Index of the INTEGER PRIMARY KEY column (an alias for an auto-assigned row id), if any. */
  readonly rowIdColumn: number | undefined;
  private nextRowId = 1n;

  constructor(
    readonly name: string,
    readonly columns: Column[],
    uniques: { columns: number[]; primary: boolean }[] = [],
  ) {
    const seen = new Set<string>();
    for (const c of columns) {
      const k = c.name.toLowerCase();
      if (seen.has(k)) throw new SqlError(`duplicate column name: ${c.name}`);
      seen.add(k);
    }
    for (const u of uniques) this.uniques.push({ ...u, keys: new Map() });
    const pk = uniques.find((u) => u.primary);
    this.rowIdColumn =
      pk && pk.columns.length === 1 && columns[pk.columns[0]!]!.type.toUpperCase() === "INTEGER" ? pk.columns[0] : undefined;
  }

  columnIndex(name: string): number {
    const i = this.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
    if (i < 0) throw new SqlError(`table ${this.name} has no column named ${name}`);
    return i;
  }

  /** Copy for transaction snapshots. Rows are immutable arrays, so a shallow copy suffices. */
  clone(): Table {
    const t = new Table(this.name, this.columns, this.uniques.map((u) => ({ columns: u.columns, primary: u.primary })));
    t.replaceRows(this.rows.slice());
    return t;
  }

  private uniqueKey(u: UniqueConstraint, row: Value[]): string | undefined {
    const vals = u.columns.map((i) => row[i]!);
    return vals.some((v) => v === null) ? undefined : keyOf(vals);
  }

  private constraintName(u: UniqueConstraint): string {
    return `${u.primary ? "PRIMARY KEY" : "UNIQUE"} constraint failed: ${u.columns.map((i) => `${this.name}.${this.columns[i]!.name}`).join(", ")}`;
  }

  /** Find the constraint a row would violate, if any. */
  conflict(row: Value[]): { constraint: UniqueConstraint; existing: Value[] } | undefined {
    for (const u of this.uniques) {
      const k = this.uniqueKey(u, row);
      if (k === undefined) continue;
      const existing = u.keys.get(k);
      if (existing) return { constraint: u, existing };
    }
    return undefined;
  }

  /** Validate NOT NULL and assign a row id; returns the completed row. */
  prepareRow(row: Value[]): Value[] {
    if (this.rowIdColumn !== undefined) {
      const v = row[this.rowIdColumn];
      if (v === null) row[this.rowIdColumn] = this.nextRowId;
      else if (typeof v !== "bigint") throw new SqlError("datatype mismatch");
    }
    this.columns.forEach((c, i) => {
      if (c.notNull && row[i] === null) throw new SqlError(`NOT NULL constraint failed: ${this.name}.${c.name}`);
    });
    return row;
  }

  insertRow(row: Value[]): void {
    const c = this.conflict(row);
    if (c) throw new SqlError(this.constraintName(c.constraint));
    this.rows.push(row);
    for (const u of this.uniques) {
      const k = this.uniqueKey(u, row);
      if (k !== undefined) u.keys.set(k, row);
    }
    this.bumpRowId(row);
  }

  private bumpRowId(row: Value[]): void {
    if (this.rowIdColumn === undefined) return;
    const id = row[this.rowIdColumn] as bigint;
    if (id >= this.nextRowId) this.nextRowId = id + 1n;
  }

  /** Replace all rows, rebuilding constraint indexes; throws (leaving the table unchanged) on a violation. */
  replaceRows(rows: Value[][]): void {
    const fresh = this.uniques.map(() => new Map<string, Value[]>());
    for (const row of rows) {
      this.uniques.forEach((u, i) => {
        const k = this.uniqueKey(u, row);
        if (k === undefined) return;
        if (fresh[i]!.has(k)) throw new SqlError(this.constraintName(u));
        fresh[i]!.set(k, row);
      });
    }
    this.rows = rows;
    this.uniques.forEach((u, i) => (u.keys = fresh[i]!));
    for (const row of rows) this.bumpRowId(row);
  }
}

/** Result of one statement. */
export interface QueryResult {
  columns: string[];
  rows: Value[][];
  /** Rows inserted, updated or deleted by a DML statement. */
  changes: number;
  /** Row id of the last row inserted into a table with an INTEGER PRIMARY KEY. */
  lastInsertRowid?: bigint;
}

export type Row = Record<string, unknown>;

export interface DatabaseOptions {
  /** Return INTEGER values as `bigint` instead of `number` (default false: safe ints become numbers). */
  safeIntegers?: boolean;
}

export class Database {
  private tables = new Map<string, Table>();
  private snapshot: Map<string, Table> | undefined;
  private readonly safeIntegers: boolean;

  constructor(options: DatabaseOptions = {}) {
    this.safeIntegers = options.safeIntegers ?? false;
  }

  /** True while an explicit BEGIN ... COMMIT/ROLLBACK transaction is open. */
  get inTransaction(): boolean {
    return this.snapshot !== undefined;
  }

  /** Execute every statement in `sql`, returning one raw result per statement. */
  execute(sql: string, params: Params = []): QueryResult[] {
    return parse(sql).map((stmt) => this.executeStatement(stmt, params));
  }

  /** Run a script (or one statement); returns the last statement's result with JS-friendly values. */
  exec(sql: string, params: Params = []): QueryResult {
    const results = this.execute(sql, params);
    const last = results[results.length - 1] ?? { columns: [], rows: [], changes: 0 };
    return { ...last, rows: last.rows.map((r) => r.map((v) => this.toJs(v)) as Value[]) };
  }

  /** Rows of a query as objects keyed by column name. */
  query<T extends Row = Row>(sql: string, params: Params = []): T[] {
    const r = this.exec(sql, params);
    return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])) as T);
  }

  /** First row of a query, or undefined. */
  get<T extends Row = Row>(sql: string, params: Params = []): T | undefined {
    return this.query<T>(sql, params)[0];
  }

  /** Run a statement for its side effects. */
  run(sql: string, params: Params = []): { changes: number; lastInsertRowid?: bigint } {
    const r = this.exec(sql, params);
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }

  tableNames(): string[] {
    return [...this.tables.values()].map((t) => t.name).sort();
  }

  table(name: string): Table | undefined {
    return this.tables.get(name.toLowerCase());
  }

  /** Reconstruct a CREATE TABLE statement for a table. */
  schema(name: string): string {
    const t = this.table(name);
    if (!t) throw new SqlError(`no such table: ${name}`);
    const parts = t.columns.map((c, i) => {
      let s = `  ${quoteIdent(c.name)}${c.type ? " " + c.type : ""}`;
      if (t.uniques.some((u) => u.primary && u.columns.length === 1 && u.columns[0] === i)) s += " PRIMARY KEY";
      if (c.notNull) s += " NOT NULL";
      if (t.uniques.some((u) => !u.primary && u.columns.length === 1 && u.columns[0] === i)) s += " UNIQUE";
      return s;
    });
    for (const u of t.uniques) {
      if (u.columns.length > 1) parts.push(`  ${u.primary ? "PRIMARY KEY" : "UNIQUE"} (${u.columns.map((i) => quoteIdent(t.columns[i]!.name)).join(", ")})`);
    }
    return `CREATE TABLE ${quoteIdent(t.name)} (\n${parts.join(",\n")}\n);`;
  }

  private toJs(v: Value): Value {
    if (typeof v === "bigint" && !this.safeIntegers && v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(v);
    }
    return v;
  }

  private context(params: Params): ExecContext {
    const catalog: Catalog = {
      getTable: (name) => {
        const t = this.table(name);
        if (!t) throw new SqlError(`no such table: ${name}`);
        return { name: t.name, columns: t.columns, rows: t.rows };
      },
    };
    return { catalog, params, subqueryCache: new Map() };
  }

  private executeStatement(stmt: Statement, params: Params): QueryResult {
    const ctx = this.context(params);
    const none = { columns: [], rows: [], changes: 0 };
    switch (stmt.kind) {
      case "select": {
        const r = executeSelect(stmt, ctx);
        return { columns: r.columnNames, rows: r.rows, changes: 0 };
      }
      case "createTable":
        this.createTable(stmt, ctx);
        return none;
      case "dropTable": {
        const key = stmt.name.toLowerCase();
        if (!this.tables.has(key)) {
          if (stmt.ifExists) return none;
          throw new SqlError(`no such table: ${stmt.name}`);
        }
        this.tables.delete(key);
        return none;
      }
      case "insert":
        return this.atomically(stmt.table, () => this.insert(stmt, ctx));
      case "update":
        return this.atomically(stmt.table, (t) => {
          const sets = stmt.set.map((s) => ({ index: t.columnIndex(s.column), value: s.value }));
          let changes = 0;
          const cols = t.columns.map((c) => ({ table: t.name, name: c.name }));
          const next = t.rows.map((row) => {
            const scope: Scope = { columns: cols, row };
            if (stmt.where && truthy(evaluate(stmt.where, scope, ctx)) !== true) return row;
            changes++;
            const updated = row.slice();
            // all SET expressions see the old row, as in standard SQL
            for (const s of sets) updated[s.index] = applyAffinity(evaluate(s.value, scope, ctx), t.columns[s.index]!.affinity);
            return t.prepareRow(updated);
          });
          t.replaceRows(next);
          return { columns: [], rows: [], changes };
        });
      case "delete":
        return this.atomically(stmt.table, (t) => {
          const cols = t.columns.map((c) => ({ table: t.name, name: c.name }));
          const keep = stmt.where
            ? t.rows.filter((row) => truthy(evaluate(stmt.where!, { columns: cols, row }, ctx)) !== true)
            : [];
          const changes = t.rows.length - keep.length;
          t.replaceRows(keep);
          return { columns: [], rows: [], changes };
        });
      case "begin":
        if (this.snapshot) throw new SqlError("cannot start a transaction within a transaction");
        this.snapshot = new Map([...this.tables].map(([k, t]) => [k, t.clone()]));
        return none;
      case "commit":
        if (!this.snapshot) throw new SqlError("cannot commit - no transaction is active");
        this.snapshot = undefined;
        return none;
      case "rollback":
        if (!this.snapshot) throw new SqlError("cannot rollback - no transaction is active");
        this.tables = this.snapshot;
        this.snapshot = undefined;
        return none;
    }
  }

  /** Run a DML statement so that it either fully applies or leaves the table untouched. */
  private atomically(name: string, fn: (t: Table) => QueryResult): QueryResult {
    const t = this.table(name);
    if (!t) throw new SqlError(`no such table: ${name}`);
    const backup = t.clone();
    try {
      return fn(t);
    } catch (err) {
      t.replaceRows(backup.rows);
      throw err;
    }
  }

  private createTable(stmt: CreateTableStmt, ctx: ExecContext): void {
    const key = stmt.name.toLowerCase();
    if (this.tables.has(key)) {
      if (stmt.ifNotExists) return;
      throw new SqlError(`table ${stmt.name} already exists`);
    }
    if (stmt.asSelect) {
      const r = executeSelect(stmt.asSelect, ctx);
      const t = new Table(stmt.name, r.columnNames.map((name) => ({ name, type: "", affinity: "BLOB" as Affinity, notNull: false })));
      for (const row of r.rows) t.insertRow(row.slice());
      this.tables.set(key, t);
      return;
    }
    const columns: Column[] = stmt.columns.map((c: ColumnDef) => ({
      name: c.name,
      type: c.type,
      affinity: affinityOf(c.type),
      notNull: c.notNull,
      default: c.default,
    }));
    const idx = (name: string) => {
      const i = columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
      if (i < 0) throw new SqlError(`no such column: ${name}`);
      return i;
    };
    const uniques: { columns: number[]; primary: boolean }[] = [];
    stmt.columns.forEach((c, i) => {
      if (c.primaryKey) uniques.push({ columns: [i], primary: true });
      if (c.unique) uniques.push({ columns: [i], primary: false });
    });
    if (stmt.primaryKey) uniques.push({ columns: stmt.primaryKey.map(idx), primary: true });
    for (const u of stmt.uniques) uniques.push({ columns: u.map(idx), primary: false });
    this.tables.set(key, new Table(stmt.name, columns, uniques));
  }

  private insert(stmt: InsertStmt, ctx: ExecContext): QueryResult {
    const t = this.table(stmt.table)!;
    const targets = stmt.columns ? stmt.columns.map((c) => t.columnIndex(c)) : t.columns.map((_, i) => i);
    let sourceRows: Value[][];
    switch (stmt.source.kind) {
      case "defaults":
        sourceRows = [[]];
        break;
      case "values":
        sourceRows = stmt.source.rows.map((r) => r.map((e) => evaluate(e, { columns: [], row: [] }, ctx)));
        break;
      case "select":
        sourceRows = executeSelect(stmt.source.query, ctx).rows;
        break;
    }
    let changes = 0;
    let lastInsertRowid: bigint | undefined;
    for (const src of sourceRows) {
      if (stmt.source.kind !== "defaults" && src.length !== targets.length) {
        throw new SqlError(`table ${t.name} has ${t.columns.length} columns but ${src.length} values were supplied`);
      }
      const row: Value[] = t.columns.map((c) => (c.default ? evaluate(c.default, { columns: [], row: [] }, ctx) : null));
      if (stmt.source.kind !== "defaults") targets.forEach((ci, i) => (row[ci] = src[i]!));
      const prepared = t.prepareRow(row.map((v, i) => applyAffinity(v, t.columns[i]!.affinity)));
      const conflict = t.conflict(prepared);
      if (conflict) {
        if (stmt.orIgnore) continue;
        if (stmt.orReplace) {
          // delete every row this one collides with, then insert
          const clash = new Set<Value[]>();
          for (const u of t.uniques) {
            const vals = u.columns.map((i) => prepared[i]!);
            if (vals.some((v) => v === null)) continue;
            const hit = u.keys.get(keyOf(vals));
            if (hit) clash.add(hit);
          }
          t.replaceRows(t.rows.filter((r) => !clash.has(r)));
        }
      }
      t.insertRow(prepared);
      changes++;
      if (t.rowIdColumn !== undefined) lastInsertRowid = prepared[t.rowIdColumn] as bigint;
    }
    return { columns: [], rows: [], changes, lastInsertRowid };
  }
}

function quoteIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

