/**
 * Expression evaluation and SELECT execution.
 *
 * Rows flow through the pipeline as plain `Value[]` arrays paired with a list of
 * column descriptors. Expressions are evaluated against a `Scope` (the current
 * row plus, for aggregate queries, the rows of the current group) whose parent
 * chain gives correlated subqueries access to outer rows.
 */
import type { Expr, FromItem, OrderTerm, SelectCore, SelectItem, SelectStmt } from "./ast";
import { callAggregate, callScalar, isAggregateCall, like } from "./functions";
import {
  SqlError, castValue, compareNumbers, compareValues, fromBool, intOrReal, isNumeric, keyOf,
  toNumeric, toText, truthy, type Value,
} from "./values";

export interface ColumnInfo {
  /** Table name or alias this column is visible under (undefined for unnamed derived columns). */
  table?: string;
  name: string;
  /** Right-hand column of a USING join: hidden from unqualified lookup and `*`. */
  hidden?: boolean;
}

export interface Relation {
  columns: ColumnInfo[];
  rows: Value[][];
}

export interface Scope {
  columns: ColumnInfo[];
  row: Value[];
  /** Rows of the current group when evaluating an aggregate query. */
  group?: Value[][];
  parent?: Scope;
  /** Set when a lookup passes through this scope (used to detect correlated subqueries). */
  probe?: { used: boolean };
}

export type Params = readonly Value[] | Readonly<Record<string, Value>>;

/** What the executor needs from the database. */
export interface Catalog {
  getTable(name: string): Relation & { name: string };
}

export interface ExecContext {
  catalog: Catalog;
  params: Params;
  /** Results of uncorrelated subqueries, valid for one statement. */
  subqueryCache: Map<SelectStmt, Relation>;
}

const EMPTY_SCOPE: Scope = { columns: [], row: [] };
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ------------------------------------------------------------ name lookup

function resolveColumn(scope: Scope, table: string | undefined, name: string): Value {
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    if (s.probe) s.probe.used = true;
    let found = -1;
    for (let i = 0; i < s.columns.length; i++) {
      const c = s.columns[i]!;
      if (!eq(c.name, name)) continue;
      if (table === undefined ? c.hidden : c.table === undefined || !eq(c.table, table)) continue;
      if (found >= 0) throw new SqlError(`ambiguous column name: ${table ? table + "." : ""}${name}`);
      found = i;
    }
    if (found >= 0) return s.row[found] ?? null;
  }
  throw new SqlError(`no such column: ${table ? table + "." : ""}${name}`);
}

function paramValue(ctx: ExecContext, key: number | string): Value {
  const p = ctx.params;
  if (Array.isArray(p)) {
    if (typeof key !== "number") throw new SqlError(`named parameter ${key} used with positional bindings`);
    return toSqlValue((p as readonly unknown[])[key - 1]);
  }
  const rec = p as Readonly<Record<string, unknown>>;
  if (typeof key === "number") {
    if (String(key) in rec) return toSqlValue(rec[String(key)]);
    throw new SqlError(`missing value for parameter ?${key}`);
  }
  if (key in rec) return toSqlValue(rec[key]);
  const bare = key.slice(1);
  if (bare in rec) return toSqlValue(rec[bare]);
  throw new SqlError(`missing value for parameter ${key}`);
}

/** Convert a JS value supplied by the caller into a SQL value. */
export function toSqlValue(v: unknown): Value {
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? BigInt(v) : v;
  if (typeof v === "boolean") return v ? 1n : 0n;
  if (v instanceof Date) return v.toISOString();
  throw new SqlError(`cannot bind value of type ${typeof v}`);
}

// ------------------------------------------------------------- evaluation

export function containsAggregate(e: Expr): boolean {
  switch (e.kind) {
    case "call":
      return isAggregateCall(e.name, e.args.length, e.star) || e.args.some(containsAggregate);
    case "unary":
    case "isNull":
    case "cast":
      return containsAggregate(e.expr);
    case "binary":
    case "is":
      return containsAggregate(e.left) || containsAggregate(e.right);
    case "between":
      return [e.expr, e.low, e.high].some(containsAggregate);
    case "inList":
      return containsAggregate(e.expr) || e.list.some(containsAggregate);
    case "inSelect":
      return containsAggregate(e.expr);
    case "like":
      return containsAggregate(e.expr) || containsAggregate(e.pattern) || (!!e.escape && containsAggregate(e.escape));
    case "case":
      return (
        (!!e.base && containsAggregate(e.base)) ||
        e.whens.some((w) => containsAggregate(w.when) || containsAggregate(w.then)) ||
        (!!e.else && containsAggregate(e.else))
      );
    default:
      return false;
  }
}

function arith(op: string, a: Value, b: Value): Value {
  const x = toNumeric(a);
  const y = toNumeric(b);
  if (x === null || y === null) return null;
  if (typeof x === "bigint" && typeof y === "bigint") {
    switch (op) {
      case "+": return intOrReal(x + y);
      case "-": return intOrReal(x - y);
      case "*": return intOrReal(x * y);
      case "/":
        if (y === 0n) return null;
        if (x === -9223372036854775808n && y === -1n) return 9223372036854775808;
        return x / y;
      case "%":
        return y === 0n ? null : x % y;
      case "&": return BigInt.asIntN(64, x & y);
      case "|": return BigInt.asIntN(64, x | y);
      case "<<": return shift(x, y);
      case ">>": return shift(x, -y);
    }
  }
  const fx = Number(x);
  const fy = Number(y);
  switch (op) {
    case "+": return fx + fy;
    case "-": return fx - fy;
    case "*": return fx * fy;
    case "/": return fy === 0 ? null : fx / fy;
    case "%": {
      // SQLite casts REAL operands of % to integers
      const ix = BigInt(Math.trunc(fx));
      const iy = BigInt(Math.trunc(fy));
      return iy === 0n ? null : Number(ix % iy);
    }
    default:
      return arith(op, castValue(x, "INTEGER"), castValue(y, "INTEGER"));
  }
}

function shift(x: bigint, by: bigint): bigint {
  if (by >= 64n) return 0n;
  if (by <= -64n) return x < 0n ? -1n : 0n;
  return by >= 0n ? BigInt.asIntN(64, x << by) : x >> -by;
}

/** SQL comparison: NULL if either side is NULL, otherwise the type-aware order. */
function compareSql(a: Value, b: Value): number | null {
  if (a === null || b === null) return null;
  if (isNumeric(a) && isNumeric(b)) return compareNumbers(a, b);
  return compareValues(a, b);
}

export function evaluate(e: Expr, scope: Scope, ctx: ExecContext): Value {
  switch (e.kind) {
    case "literal":
      return e.value;
    case "column":
      return resolveColumn(scope, e.table, e.name);
    case "param":
      return paramValue(ctx, e.key);
    case "unary": {
      const v = evaluate(e.expr, scope, ctx);
      switch (e.op) {
        case "NOT": {
          const t = truthy(v);
          return t === null ? null : fromBool(!t);
        }
        case "-": {
          const n = toNumeric(v);
          if (n === null) return null;
          return typeof n === "bigint" ? intOrReal(-n) : -n;
        }
        case "+":
          return v;
        case "~": {
          const n = castValue(v, "INTEGER");
          return n === null ? null : ~(n as bigint);
        }
      }
      break;
    }
    case "binary": {
      if (e.op === "AND" || e.op === "OR") {
        // three-valued logic with short-circuiting
        const l = truthy(evaluate(e.left, scope, ctx));
        if (e.op === "AND" && l === false) return 0n;
        if (e.op === "OR" && l === true) return 1n;
        const r = truthy(evaluate(e.right, scope, ctx));
        if (e.op === "AND") return r === false ? 0n : l === null || r === null ? null : 1n;
        return r === true ? 1n : l === null || r === null ? null : 0n;
      }
      const l = evaluate(e.left, scope, ctx);
      const r = evaluate(e.right, scope, ctx);
      switch (e.op) {
        case "=": case "!=": case "<": case "<=": case ">": case ">=": {
          const c = compareSql(l, r);
          if (c === null) return null;
          const result =
            e.op === "=" ? c === 0 : e.op === "!=" ? c !== 0 : e.op === "<" ? c < 0 : e.op === "<=" ? c <= 0 : e.op === ">" ? c > 0 : c >= 0;
          return fromBool(result);
        }
        case "||": {
          if (l === null || r === null) return null;
          return toText(l)! + toText(r)!;
        }
        default:
          return arith(e.op, l, r);
      }
    }
    case "isNull": {
      const isNull = evaluate(e.expr, scope, ctx) === null;
      return fromBool(e.not ? !isNull : isNull);
    }
    case "is": {
      const l = evaluate(e.left, scope, ctx);
      const r = evaluate(e.right, scope, ctx);
      const same = l === null || r === null ? l === r : compareSql(l, r) === 0;
      return fromBool(e.not ? !same : same);
    }
    case "between": {
      const v = evaluate(e.expr, scope, ctx);
      const lo = compareSql(v, evaluate(e.low, scope, ctx));
      const hi = compareSql(v, evaluate(e.high, scope, ctx));
      const geLo = lo === null ? null : lo >= 0;
      const leHi = hi === null ? null : hi <= 0;
      let result: boolean | null;
      if (geLo === false || leHi === false) result = false;
      else if (geLo === null || leHi === null) result = null;
      else result = true;
      return fromBool(result === null ? null : e.not ? !result : result);
    }
    case "inList":
      return inValues(evaluate(e.expr, scope, ctx), () => e.list.map((x) => evaluate(x, scope, ctx)), e.not);
    case "inSelect": {
      const v = evaluate(e.expr, scope, ctx);
      const rel = runSubquery(e.query, scope, ctx);
      if (rel.columns.length !== 1) throw new SqlError(`sub-select returns ${rel.columns.length} columns - expected 1`);
      return inValues(v, () => rel.rows.map((r) => r[0]!), e.not);
    }
    case "exists": {
      const rel = runSubquery(e.query, scope, ctx);
      return fromBool(e.not ? rel.rows.length === 0 : rel.rows.length > 0);
    }
    case "subquery": {
      const rel = runSubquery(e.query, scope, ctx);
      if (rel.columns.length !== 1) throw new SqlError(`sub-select returns ${rel.columns.length} columns - expected 1`);
      return rel.rows.length ? rel.rows[0]![0]! : null;
    }
    case "like": {
      const v = evaluate(e.expr, scope, ctx);
      const p = evaluate(e.pattern, scope, ctx);
      const esc = e.escape ? evaluate(e.escape, scope, ctx) : undefined;
      if (v === null || p === null || esc === null) return null;
      const escText = esc === undefined ? undefined : toText(esc)!;
      if (escText !== undefined && Array.from(escText).length !== 1) throw new SqlError("ESCAPE expression must be a single character");
      const m = like(toText(v)!, toText(p)!, escText);
      return fromBool(e.not ? !m : m);
    }
    case "case": {
      if (e.base) {
        const base = evaluate(e.base, scope, ctx);
        for (const w of e.whens) {
          if (compareSql(base, evaluate(w.when, scope, ctx)) === 0) return evaluate(w.then, scope, ctx);
        }
      } else {
        for (const w of e.whens) if (truthy(evaluate(w.when, scope, ctx)) === true) return evaluate(w.then, scope, ctx);
      }
      return e.else ? evaluate(e.else, scope, ctx) : null;
    }
    case "cast":
      return castValue(evaluate(e.expr, scope, ctx), e.type);
    case "call": {
      if (isAggregateCall(e.name, e.args.length, e.star)) return evalAggregate(e, scope, ctx);
      if (e.star) throw new SqlError(`${e.name}(*) is not allowed`);
      if (e.distinct) throw new SqlError(`DISTINCT is only allowed in aggregate functions`);
      // short-circuit the lazy conditionals
      if (e.name === "coalesce" || e.name === "ifnull") {
        if (e.name === "coalesce" && e.args.length < 2) throw new SqlError(`wrong number of arguments to function coalesce()`);
        if (e.name === "ifnull" && e.args.length !== 2) throw new SqlError(`wrong number of arguments to function ifnull()`);
        for (const a of e.args) {
          const v = evaluate(a, scope, ctx);
          if (v !== null) return v;
        }
        return null;
      }
      return callScalar(e.name, e.args.map((a) => evaluate(a, scope, ctx)));
    }
  }
  throw new SqlError(`cannot evaluate ${(e as Expr).kind}`);
}

function inValues(v: Value, list: () => Value[], not: boolean): Value {
  const items = list();
  if (items.length === 0) return fromBool(not);
  if (v === null) return null;
  let sawNull = false;
  for (const x of items) {
    if (x === null) sawNull = true;
    else if (compareSql(v, x) === 0) return fromBool(!not);
  }
  return sawNull ? null : fromBool(not);
}

function evalAggregate(e: Extract<Expr, { kind: "call" }>, scope: Scope, ctx: ExecContext): Value {
  // find the nearest scope carrying a group
  let s: Scope | undefined = scope;
  while (s && !s.group) s = s.parent;
  if (!s?.group) throw new SqlError(`misuse of aggregate function ${e.name}()`);
  const groupScope = s;
  const argRows: Value[][] = [];
  for (const row of groupScope.group!) {
    const rowScope: Scope = { columns: groupScope.columns, row, parent: groupScope.parent };
    for (const a of e.args) if (containsAggregate(a)) throw new SqlError(`misuse of aggregate function ${e.name}()`);
    argRows.push(e.args.map((a) => evaluate(a, rowScope, ctx)));
  }
  let rows = argRows;
  if (e.distinct) {
    if (e.args.length !== 1) throw new SqlError(`DISTINCT aggregates must have exactly one argument`);
    const seen = new Set<string>();
    rows = argRows.filter((r) => {
      const k = keyOf(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  if (e.name === "count" && !e.star && e.args.length !== 1) throw new SqlError(`wrong number of arguments to function count()`);
  if ((e.name === "sum" || e.name === "avg" || e.name === "total") && e.args.length !== 1) {
    throw new SqlError(`wrong number of arguments to function ${e.name}()`);
  }
  return callAggregate(e.name, rows, e.star);
}

function runSubquery(query: SelectStmt, scope: Scope, ctx: ExecContext): Relation {
  const cached = ctx.subqueryCache.get(query);
  if (cached) return cached;
  const probe = { used: false };
  const outer: Scope = { columns: [], row: [], parent: scope, probe };
  const rel = executeSelect(query, ctx, outer);
  if (!probe.used) ctx.subqueryCache.set(query, rel);
  return rel;
}

// ------------------------------------------------------------------- FROM

function scanFrom(from: FromItem, ctx: ExecContext, outer: Scope | undefined): Relation {
  switch (from.kind) {
    case "table": {
      const t = ctx.catalog.getTable(from.name);
      const alias = from.alias ?? t.name;
      return { columns: t.columns.map((c) => ({ table: alias, name: c.name })), rows: t.rows };
    }
    case "subquery": {
      const rel = executeSelect(from.query, ctx, outer);
      return { columns: rel.columns.map((c) => ({ table: from.alias, name: c.name })), rows: rel.rows };
    }
    case "join":
      return join(from, ctx, outer);
  }
}

function join(j: Extract<FromItem, { kind: "join" }>, ctx: ExecContext, outer: Scope | undefined): Relation {
  const left = scanFrom(j.left, ctx, outer);
  const right = scanFrom(j.right, ctx, outer);
  const rightCols = right.columns.map((c) => ({ ...c }));
  let on = j.on;
  if (j.using) {
    // USING (a, b) == ON l.a = r.a AND l.b = r.b, with r.a/r.b hidden from unqualified lookup
    const conds: Expr[] = [];
    for (const name of j.using) {
      const li = left.columns.filter((c) => !c.hidden && eq(c.name, name));
      const ri = rightCols.findIndex((c) => eq(c.name, name));
      if (li.length !== 1 || ri < 0) throw new SqlError(`cannot join using column ${name} - column not present in both tables`);
      rightCols[ri]!.hidden = true;
      conds.push({
        kind: "binary", op: "=",
        left: { kind: "column", table: li[0]!.table, name: li[0]!.name },
        right: { kind: "column", table: rightCols[ri]!.table, name },
      });
    }
    on = conds.reduce((a, b) => ({ kind: "binary", op: "AND", left: a, right: b }));
  }
  const columns = [...left.columns, ...rightCols];
  const rows: Value[][] = [];
  const nullRight = right.columns.map(() => null);
  const matches = (row: Value[]) => !on || truthy(evaluate(on, { columns, row, parent: outer }, ctx)) === true;

  // Equi-join fast path: hash the right side on the first `left.col = right.col` conjunct.
  const hashKey = on ? findEquiKey(on, left.columns, rightCols) : undefined;
  if (hashKey) {
    const buckets = new Map<string, Value[][]>();
    for (const r of right.rows) {
      const v = r[hashKey.right]!;
      if (v === null) continue;
      const k = keyOf([v]);
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = []));
      b.push(r);
    }
    for (const l of left.rows) {
      const v = l[hashKey.left]!;
      let matched = false;
      for (const r of v === null ? [] : buckets.get(keyOf([v])) ?? []) {
        const row = [...l, ...r];
        if (matches(row)) {
          rows.push(row);
          matched = true;
        }
      }
      if (!matched && j.type === "LEFT") rows.push([...l, ...nullRight]);
    }
    return { columns, rows };
  }

  for (const l of left.rows) {
    let matched = false;
    for (const r of right.rows) {
      const row = [...l, ...r];
      if (matches(row)) {
        rows.push(row);
        matched = true;
      }
    }
    if (!matched && j.type === "LEFT") rows.push([...l, ...nullRight]);
  }
  return { columns, rows };
}

function columnIndex(cols: ColumnInfo[], e: Expr): number | undefined {
  if (e.kind !== "column") return undefined;
  const hits: number[] = [];
  cols.forEach((c, i) => {
    if (!eq(c.name, e.name)) return;
    if (e.table === undefined ? c.hidden : c.table === undefined || !eq(c.table, e.table)) return;
    hits.push(i);
  });
  return hits.length === 1 ? hits[0] : undefined;
}

function findEquiKey(on: Expr, left: ColumnInfo[], right: ColumnInfo[]): { left: number; right: number } | undefined {
  if (on.kind === "binary" && on.op === "AND") return findEquiKey(on.left, left, right) ?? findEquiKey(on.right, left, right);
  if (on.kind !== "binary" || on.op !== "=") return undefined;
  const both = [...left, ...right];
  const a = columnIndex(both, on.left);
  const b = columnIndex(both, on.right);
  if (a === undefined || b === undefined) return undefined;
  if (a < left.length && b >= left.length) return { left: a, right: b - left.length };
  if (b < left.length && a >= left.length) return { left: b, right: a - left.length };
  return undefined;
}

// ----------------------------------------------------------------- SELECT

interface CoreResult {
  columns: string[];
  rows: Value[][];
  /** Per-row ORDER BY keys, when the caller asked for them. */
  sortKeys?: Value[][];
}

function itemName(item: Extract<SelectItem, { kind: "expr" }>): string {
  if (item.alias !== undefined) return item.alias;
  if (item.expr.kind === "column") return item.expr.name;
  return item.text;
}

function runCore(core: SelectCore, ctx: ExecContext, outer: Scope | undefined, orderBy?: OrderTerm[]): CoreResult {
  const source: Relation = core.from ? scanFrom(core.from, ctx, outer) : { columns: [], rows: [[]] };

  // expand * and t.* into concrete output columns
  const outputs: { name: string; expr: Expr }[] = [];
  for (const item of core.columns) {
    if (item.kind === "expr") {
      outputs.push({ name: itemName(item), expr: item.expr });
      continue;
    }
    if (!core.from) throw new SqlError("no tables specified");
    let any = false;
    for (const c of source.columns) {
      if (c.hidden) continue;
      if (item.table !== undefined && (c.table === undefined || !eq(c.table, item.table))) continue;
      outputs.push({ name: c.name, expr: { kind: "column", table: c.table, name: c.name } });
      any = true;
    }
    if (!any && item.table !== undefined) throw new SqlError(`no such table: ${item.table}`);
  }

  let rows = source.rows;
  if (core.where) {
    if (containsAggregate(core.where)) throw new SqlError("misuse of aggregate function in WHERE");
    rows = rows.filter((row) => truthy(evaluate(core.where!, { columns: source.columns, row, parent: outer }, ctx)) === true);
  }

  const aggregate =
    core.groupBy.length > 0 ||
    !!core.having ||
    outputs.some((o) => containsAggregate(o.expr)) ||
    (orderBy ?? []).some((o) => containsAggregate(o.expr));

  let scopes: Scope[];
  if (aggregate) {
    for (const g of core.groupBy) if (containsAggregate(g)) throw new SqlError("aggregate functions are not allowed in the GROUP BY clause");
    const groups = new Map<string, Value[][]>();
    for (const row of rows) {
      const s: Scope = { columns: source.columns, row, parent: outer };
      const key = keyOf(core.groupBy.map((g) => groupKeyValue(g, s, ctx, outputs)));
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(row);
    }
    if (groups.size === 0 && core.groupBy.length === 0) groups.set("", []);
    scopes = [...groups.values()].map((g) => ({
      columns: source.columns,
      row: g[0] ?? source.columns.map(() => null),
      group: g,
      parent: outer,
    }));
    if (core.having) scopes = scopes.filter((s) => truthy(evaluate(core.having!, s, ctx)) === true);
  } else {
    scopes = rows.map((row) => ({ columns: source.columns, row, parent: outer }));
  }

  const names = outputs.map((o) => o.name);
  const outRows: Value[][] = [];
  const sortKeys: Value[][] | undefined = orderBy?.length ? [] : undefined;
  for (const s of scopes) {
    const out = outputs.map((o) => evaluate(o.expr, s, ctx));
    outRows.push(out);
    if (sortKeys) sortKeys.push(orderBy!.map((t) => orderKey(t, out, names, s, ctx)));
  }

  if (core.distinct) {
    const seen = new Set<string>();
    const keepRows: Value[][] = [];
    const keepKeys: Value[][] = [];
    outRows.forEach((r, i) => {
      const k = keyOf(r);
      if (seen.has(k)) return;
      seen.add(k);
      keepRows.push(r);
      if (sortKeys) keepKeys.push(sortKeys[i]!);
    });
    return { columns: names, rows: keepRows, sortKeys: sortKeys ? keepKeys : undefined };
  }
  return { columns: names, rows: outRows, sortKeys };
}

/** GROUP BY terms may name an output alias or position, like ORDER BY. */
function groupKeyValue(g: Expr, s: Scope, ctx: ExecContext, outputs: { name: string; expr: Expr }[]): Value {
  if (g.kind === "literal" && typeof g.value === "bigint") {
    const o = outputs[Number(g.value) - 1];
    if (!o) throw new SqlError(`GROUP BY term out of range - should be between 1 and ${outputs.length}`);
    return evaluate(o.expr, s, ctx);
  }
  if (g.kind === "column" && g.table === undefined && !s.columns.some((c) => eq(c.name, g.name))) {
    const o = outputs.find((x) => eq(x.name, g.name));
    if (o && !containsAggregate(o.expr)) return evaluate(o.expr, s, ctx);
  }
  return evaluate(g, s, ctx);
}

function orderKey(t: OrderTerm, out: Value[], names: string[], s: Scope, ctx: ExecContext): Value {
  const e = t.expr;
  if (e.kind === "literal" && typeof e.value === "bigint") {
    const i = Number(e.value);
    if (i < 1 || i > out.length) throw new SqlError(`ORDER BY term out of range - should be between 1 and ${out.length}`);
    return out[i - 1]!;
  }
  if (e.kind === "column" && e.table === undefined) {
    const i = names.findIndex((n) => eq(n, e.name));
    if (i >= 0) return out[i]!;
  }
  return evaluate(e, s, ctx);
}

function compoundOrderIndex(t: OrderTerm, names: string[]): number {
  const e = t.expr;
  if (e.kind === "literal" && typeof e.value === "bigint") {
    const i = Number(e.value);
    if (i < 1 || i > names.length) throw new SqlError(`ORDER BY term out of range - should be between 1 and ${names.length}`);
    return i - 1;
  }
  if (e.kind === "column") {
    const i = names.findIndex((n) => eq(n, e.name));
    if (i >= 0) return i;
  }
  throw new SqlError("ORDER BY term does not match any column in the result set");
}

function sortRows(rows: Value[][], keys: Value[][], terms: OrderTerm[]): Value[][] {
  const idx = rows.map((_, i) => i);
  idx.sort((a, b) => {
    for (let k = 0; k < terms.length; k++) {
      const t = terms[k]!;
      const x = keys[a]![k]!;
      const y = keys[b]![k]!;
      if (x === null || y === null) {
        if (x === y) continue;
        const nullsFirst = t.nullsFirst ?? !t.desc;
        return (x === null) === nullsFirst ? -1 : 1;
      }
      const c = compareValues(x, y);
      if (c !== 0) return t.desc ? -c : c;
    }
    return a - b; // stable
  });
  return idx.map((i) => rows[i]!);
}

function limitValue(e: Expr | undefined, ctx: ExecContext, what: string): number | undefined {
  if (!e) return undefined;
  const v = evaluate(e, EMPTY_SCOPE, ctx);
  const n = typeof v === "string" ? toNumeric(v) : v;
  if (n === null || (typeof n === "number" && !Number.isInteger(n))) throw new SqlError(`datatype mismatch in ${what}`);
  return Number(n);
}

export function executeSelect(stmt: SelectStmt, ctx: ExecContext, outer?: Scope): Relation & { columnNames: string[] } {
  let columns: string[];
  let rows: Value[][];
  if (stmt.compounds.length === 0) {
    const r = runCore(stmt.core, ctx, outer, stmt.orderBy);
    columns = r.columns;
    rows = r.sortKeys ? sortRows(r.rows, r.sortKeys, stmt.orderBy) : r.rows;
  } else {
    const first = runCore(stmt.core, ctx, outer);
    columns = first.columns;
    rows = first.rows;
    for (const { op, core } of stmt.compounds) {
      const next = runCore(core, ctx, outer);
      if (next.columns.length !== columns.length) {
        throw new SqlError(`SELECTs to the left and right of ${op} do not have the same number of result columns`);
      }
      rows = combine(op, rows, next.rows);
    }
    if (stmt.orderBy.length) {
      const idx = stmt.orderBy.map((t) => compoundOrderIndex(t, columns));
      rows = sortRows(rows, rows.map((r) => idx.map((i) => r[i]!)), stmt.orderBy);
    }
  }
  const limit = limitValue(stmt.limit, ctx, "LIMIT");
  const offset = limitValue(stmt.offset, ctx, "OFFSET") ?? 0;
  if (limit !== undefined || offset > 0) {
    const start = Math.max(0, offset);
    rows = rows.slice(start, limit !== undefined && limit >= 0 ? start + limit : undefined);
  }
  return { columns: columns.map((name) => ({ name })), rows, columnNames: columns };
}

function dedupe(rows: Value[][]): Value[][] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = keyOf(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function combine(op: string, left: Value[][], right: Value[][]): Value[][] {
  switch (op) {
    case "UNION ALL":
      return [...left, ...right];
    case "UNION":
      return dedupe([...left, ...right]);
    case "INTERSECT": {
      const r = new Set(right.map(keyOf));
      return dedupe(left).filter((row) => r.has(keyOf(row)));
    }
    case "EXCEPT": {
      const r = new Set(right.map(keyOf));
      return dedupe(left).filter((row) => !r.has(keyOf(row)));
    }
  }
  throw new SqlError(`unknown compound operator ${op}`);
}

