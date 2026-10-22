/** Built-in scalar and aggregate functions. */
import {
  SqlError, compareValues, intOrReal, toNumeric, toText, typeName, type Value,
} from "./values";

export const AGGREGATES = new Set(["count", "sum", "avg", "min", "max", "total", "group_concat"]);

/** min/max are aggregates with one argument and scalar functions with several. */
export function isAggregateCall(name: string, argCount: number, star: boolean): boolean {
  if (star) return name === "count";
  if (name === "min" || name === "max") return argCount === 1;
  return AGGREGATES.has(name);
}

function arity(name: string, args: Value[], min: number, max = min): void {
  if (args.length < min || args.length > max) {
    throw new SqlError(`wrong number of arguments to function ${name}()`);
  }
}

function roundHalfAway(x: number, digits: number): number {
  const f = 10 ** digits;
  const r = Math.round(Math.abs(x) * f + Number.EPSILON * Math.abs(x) * f) / f;
  return x < 0 ? -r : r;
}

/** Characters of a string by code point, so length()/substr() work on non-BMP text. */
const chars = (s: string) => Array.from(s);

type ScalarFn = (args: Value[], name: string) => Value;

const SCALARS: Record<string, ScalarFn> = {
  abs(args, name) {
    arity(name, args, 1);
    const v = toNumeric(args[0]!);
    if (v === null) return null;
    if (typeof v === "bigint") {
      if (v === -9223372036854775808n) throw new SqlError("integer overflow");
      return v < 0n ? -v : v;
    }
    return Math.abs(v);
  },
  lower(args, name) {
    arity(name, args, 1);
    const s = toText(args[0]!);
    return s === null ? null : s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  },
  upper(args, name) {
    arity(name, args, 1);
    const s = toText(args[0]!);
    return s === null ? null : s.replace(/[a-z]/g, (c) => c.toUpperCase());
  },
  length(args, name) {
    arity(name, args, 1);
    const s = toText(args[0]!);
    return s === null ? null : BigInt(chars(s).length);
  },
  coalesce(args, name) {
    if (args.length < 2) throw new SqlError(`wrong number of arguments to function ${name}()`);
    for (const a of args) if (a !== null) return a;
    return null;
  },
  ifnull(args, name) {
    arity(name, args, 2);
    return args[0] !== null ? args[0]! : args[1]!;
  },
  nullif(args, name) {
    arity(name, args, 2);
    return args[0] !== null && args[1] !== null && compareValues(args[0]!, args[1]!) === 0 ? null : args[0]!;
  },
  iif(args, name) {
    arity(name, args, 3);
    const c = toNumeric(args[0]!);
    return c !== null && (typeof c === "bigint" ? c !== 0n : c !== 0) ? args[1]! : args[2]!;
  },
  substr(args, name) {
    arity(name, args, 2, 3);
    const s = toText(args[0]!);
    const startV = toNumeric(args[1]!);
    if (s === null || startV === null) return null;
    const cs = chars(s);
    let start = Number(startV);
    let len = args.length === 3 ? toNumeric(args[2]!) : cs.length;
    if (len === null) return null;
    let n = Number(len);
    // SQLite semantics: 1-based, negative start counts from the end, negative length takes chars before start
    if (start < 0) start = cs.length + start + 1;
    else if (start === 0) {
      start = 1;
      if (n > 0) n -= 1;
    }
    let from = start - 1;
    let to = from + n;
    if (n < 0) {
      to = from;
      from = from + n;
    }
    from = Math.max(0, from);
    to = Math.max(from, Math.min(cs.length, to));
    return cs.slice(from, to).join("");
  },
  trim: (args, name) => trimImpl(args, name, true, true),
  ltrim: (args, name) => trimImpl(args, name, true, false),
  rtrim: (args, name) => trimImpl(args, name, false, true),
  replace(args, name) {
    arity(name, args, 3);
    const s = toText(args[0]!);
    const from = toText(args[1]!);
    const to = toText(args[2]!);
    if (s === null || from === null || to === null) return null;
    return from === "" ? s : s.split(from).join(to);
  },
  instr(args, name) {
    arity(name, args, 2);
    const s = toText(args[0]!);
    const needle = toText(args[1]!);
    if (s === null || needle === null) return null;
    const idx = s.indexOf(needle);
    return idx < 0 ? 0n : BigInt(chars(s.slice(0, idx)).length + 1);
  },
  round(args, name) {
    arity(name, args, 1, 2);
    const v = toNumeric(args[0]!);
    if (v === null) return null;
    const digits = args.length === 2 ? Number(toNumeric(args[1]!) ?? 0n) : 0;
    return roundHalfAway(Number(v), Math.max(0, Math.min(30, digits)));
  },
  min(args, name) {
    if (args.length < 2) throw new SqlError(`wrong number of arguments to function ${name}()`);
    if (args.some((a) => a === null)) return null;
    return args.reduce((a, b) => (compareValues(b, a) < 0 ? b : a));
  },
  max(args, name) {
    if (args.length < 2) throw new SqlError(`wrong number of arguments to function ${name}()`);
    if (args.some((a) => a === null)) return null;
    return args.reduce((a, b) => (compareValues(b, a) > 0 ? b : a));
  },
  typeof(args, name) {
    arity(name, args, 1);
    return typeName(args[0]!);
  },
  sign(args, name) {
    arity(name, args, 1);
    const v = toNumeric(args[0]!);
    if (v === null) return null;
    return v > 0 ? 1n : v < 0 ? -1n : 0n;
  },
  concat(args) {
    return args.map((a) => toText(a) ?? "").join("");
  },
  printf(args, name) {
    if (args.length < 1) throw new SqlError(`wrong number of arguments to function ${name}()`);
    return formatPrintf(toText(args[0]!) ?? "", args.slice(1));
  },
};
SCALARS.substring = SCALARS.substr!;
SCALARS.format = SCALARS.printf!;

function trimImpl(args: Value[], name: string, left: boolean, right: boolean): Value {
  arity(name, args, 1, 2);
  const s = toText(args[0]!);
  if (s === null) return null;
  const set = args.length === 2 ? toText(args[1]!) : " ";
  if (set === null) return null;
  const cs = chars(s);
  let a = 0;
  let b = cs.length;
  if (left) while (a < b && set.includes(cs[a]!)) a++;
  if (right) while (b > a && set.includes(cs[b - 1]!)) b--;
  return cs.slice(a, b).join("");
}

/** A small printf: %d %i %f %.Nf %s %x %q %% with optional width and '-' or '0' flag. */
function formatPrintf(fmt: string, args: Value[]): string {
  let i = 0;
  return fmt.replace(/%([-0]?)(\d*)(?:\.(\d+))?([difsxq%])/g, (_m, flag: string, width: string, prec: string | undefined, conv: string) => {
    if (conv === "%") return "%";
    const arg = args[i++] ?? null;
    let out: string;
    switch (conv) {
      case "d":
      case "i": {
        const n = toNumeric(arg) ?? 0n;
        out = (typeof n === "bigint" ? n : BigInt(Math.trunc(n))).toString();
        break;
      }
      case "f":
        out = Number(toNumeric(arg) ?? 0).toFixed(prec === undefined ? 6 : Number(prec));
        break;
      case "x": {
        const n = toNumeric(arg) ?? 0n;
        out = BigInt.asUintN(64, typeof n === "bigint" ? n : BigInt(Math.trunc(n))).toString(16);
        break;
      }
      case "q":
        out = (toText(arg) ?? "").replaceAll("'", "''");
        break;
      default:
        out = arg === null ? "" : toText(arg)!;
        if (prec !== undefined) out = out.slice(0, Number(prec));
    }
    const w = Number(width || 0);
    if (flag === "-") return out.padEnd(w);
    if (flag === "0" && /[difx]/.test(conv)) {
      const neg = out.startsWith("-");
      return (neg ? "-" : "") + (neg ? out.slice(1) : out).padStart(neg ? w - 1 : w, "0");
    }
    return out.padStart(w);
  });
}

export function callScalar(name: string, args: Value[]): Value {
  const fn = SCALARS[name];
  if (!fn) throw new SqlError(`no such function: ${name}`);
  return fn(args, name);
}

/** Evaluate an aggregate over the (already DISTINCT-filtered, if requested) argument lists. */
export function callAggregate(name: string, rows: Value[][], star: boolean): Value {
  switch (name) {
    case "count":
      if (star) return BigInt(rows.length);
      return BigInt(rows.filter((r) => r[0] !== null).length);
    case "sum":
    case "total": {
      let intSum = 0n;
      let realSum = 0;
      let sawReal = false;
      let sawAny = false;
      for (const [v] of rows) {
        if (v === null || v === undefined) continue;
        sawAny = true;
        const n = toNumeric(v)!;
        if (typeof n === "bigint") intSum += n;
        else {
          sawReal = true;
          realSum += n;
        }
      }
      if (name === "total") return Number(intSum) + realSum;
      if (!sawAny) return null;
      if (sawReal) return Number(intSum) + realSum;
      if (intOrReal(intSum) !== intSum) throw new SqlError("integer overflow");
      return intSum;
    }
    case "avg": {
      let sum = 0;
      let count = 0;
      for (const [v] of rows) {
        if (v === null || v === undefined) continue;
        sum += Number(toNumeric(v));
        count++;
      }
      return count ? sum / count : null;
    }
    case "min":
    case "max": {
      let best: Value = null;
      for (const [v] of rows) {
        if (v === null || v === undefined) continue;
        if (best === null) best = v;
        else {
          const c = compareValues(v, best);
          if (name === "min" ? c < 0 : c > 0) best = v;
        }
      }
      return best;
    }
    case "group_concat": {
      let out: string | null = null;
      for (const r of rows) {
        const v = r[0] ?? null;
        if (v === null) continue;
        const sep = r.length > 1 ? toText(r[1] ?? null) ?? "" : ",";
        out = out === null ? toText(v) : out + sep + toText(v);
      }
      return out;
    }
  }
  throw new SqlError(`no such aggregate: ${name}`);
}

// --------------------------------------------------------------------- LIKE

const likeCache = new Map<string, RegExp>();

/** SQL LIKE: % matches any run, _ one char, ASCII case-insensitive, optional escape char. */
export function like(text: string, pattern: string, escape?: string): boolean {
  const cacheKey = `${escape ?? ""}\u0000${pattern}`;
  let re = likeCache.get(cacheKey);
  if (!re) {
    let src = "";
    const cs = chars(pattern);
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i]!;
      if (escape !== undefined && c === escape) {
        const nextChar = cs[++i];
        if (nextChar === undefined) throw new SqlError("LIKE pattern ends with escape character");
        src += escapeRe(nextChar);
      } else if (c === "%") src += "[\\s\\S]*";
      else if (c === "_") src += "[\\s\\S]";
      else if (/[a-z]/i.test(c)) src += `[${c.toLowerCase()}${c.toUpperCase()}]`;
      else src += escapeRe(c);
    }
    re = new RegExp(`^${src}$`, "u");
    if (likeCache.size > 512) likeCache.clear();
    likeCache.set(cacheKey, re);
  }
  return re.test(text);
}

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

