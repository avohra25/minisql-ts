/**
 * Runtime values and SQLite-style type semantics.
 *
 * INTEGER values are `bigint` (exact 64-bit arithmetic, truncating division),
 * REAL values are `number`, TEXT is `string` and NULL is `null`. Keeping the
 * integer/real distinction in the JS type makes `7 / 2 = 3` and `7.0 / 2 = 3.5`
 * fall out naturally, just like in SQLite.
 */

export type Value = null | bigint | number | string;

export const INT64_MIN = -9223372036854775808n;
export const INT64_MAX = 9223372036854775807n;

export class SqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlError";
  }
}

export const isNumeric = (v: Value): v is bigint | number => typeof v === "bigint" || typeof v === "number";

/** Type rank used for ordering values of different types: NULL < numbers < text. */
function typeRank(v: Value): number {
  if (v === null) return 0;
  if (typeof v === "string") return 2;
  return 1;
}

/** Total order over values (the order used by ORDER BY, DISTINCT, GROUP BY, MIN/MAX). */
export function compareValues(a: Value, b: Value): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 2) {
    const sa = a as string;
    const sb = b as string;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  return compareNumbers(a as bigint | number, b as bigint | number);
}

export function compareNumbers(a: bigint | number, b: bigint | number): number {
  if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
  // mixed int/real: JS compares bigint and number exactly
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) ? (Number.isNaN(b) ? 0 : -1) : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Normalise an int-valued result: values outside int64 overflow to REAL, as SQLite does. */
export function intOrReal(v: bigint): bigint | number {
  return v < INT64_MIN || v > INT64_MAX ? Number(v) : v;
}

/** Render a REAL the way SQLite does (`1.0`, `0.5`, `1.0e+20`). */
export function realToText(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (!Number.isFinite(n)) return n > 0 ? "Inf" : "-Inf";
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return `${n}.0`;
  const s = String(n);
  if (/e/.test(s)) {
    const [m, e] = s.split("e");
    const mant = m!.includes(".") ? m! : `${m}.0`;
    const exp = Number(e);
    return `${mant}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return s;
}

export function toText(v: Value): string | null {
  if (v === null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "bigint") return v.toString();
  return realToText(v);
}

const NUMERIC_PREFIX = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/;

/**
 * Convert text to a number the way SQLite does for arithmetic: use the longest
 * numeric prefix, or 0 if there is none ("12abc" -> 12, "abc" -> 0).
 */
export function textToNumber(s: string): bigint | number {
  const m = NUMERIC_PREFIX.exec(s);
  if (!m) return 0n;
  const text = m[0].trim();
  if (/^[+-]?\d+$/.test(text)) return intOrReal(BigInt(text));
  return Number(text);
}

/** Is the whole string a well-formed number (ignoring surrounding spaces)? Returns it or undefined. */
export function parseWholeNumber(s: string): bigint | number | undefined {
  const m = NUMERIC_PREFIX.exec(s);
  if (!m || s.slice(m[0].length).trim() !== "") return undefined;
  return textToNumber(s);
}

export function toNumeric(v: Value): bigint | number | null {
  if (v === null) return null;
  if (typeof v === "string") return textToNumber(v);
  return v;
}

/** SQL truthiness: NULL is unknown, numbers are true when non-zero, text is coerced to a number. */
export function truthy(v: Value): boolean | null {
  if (v === null) return null;
  const n = toNumeric(v)!;
  return typeof n === "bigint" ? n !== 0n : n !== 0;
}

export const fromBool = (b: boolean | null): Value => (b === null ? null : b ? 1n : 0n);

// ------------------------------------------------------------------ affinity

export type Affinity = "INTEGER" | "REAL" | "TEXT" | "NUMERIC" | "BLOB";

/** Column affinity from a declared type, using SQLite's substring rules. */
export function affinityOf(declared: string): Affinity {
  const t = declared.toUpperCase();
  if (t.includes("INT")) return "INTEGER";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t === "" || t.includes("BLOB")) return "BLOB";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

/** Coerce a value being stored into a column with the given affinity. */
export function applyAffinity(v: Value, aff: Affinity): Value {
  if (v === null) return null;
  switch (aff) {
    case "TEXT":
      return isNumeric(v) ? toText(v) : v;
    case "INTEGER":
    case "NUMERIC": {
      let n: bigint | number | undefined = typeof v === "string" ? parseWholeNumber(v) : v;
      if (n === undefined) return v;
      if (typeof n === "number" && Number.isInteger(n) && Math.abs(n) <= 9007199254740991) n = BigInt(n);
      return n;
    }
    case "REAL": {
      const n = typeof v === "string" ? parseWholeNumber(v) : v;
      if (n === undefined) return v;
      return Number(n);
    }
    case "BLOB":
      return v;
  }
}

/** CAST(v AS type). */
export function castValue(v: Value, type: string): Value {
  if (v === null) return null;
  const aff = affinityOf(type);
  switch (aff) {
    case "TEXT":
      return toText(v);
    case "BLOB":
      return typeof v === "string" ? v : toText(v);
    case "INTEGER": {
      const n = toNumeric(v)!;
      if (typeof n === "bigint") return n;
      if (Number.isNaN(n)) return 0n;
      if (n >= 9.223372036854776e18) return INT64_MAX;
      if (n <= -9.223372036854776e18) return INT64_MIN;
      return BigInt(Math.trunc(n));
    }
    case "REAL":
      return Number(toNumeric(v));
    case "NUMERIC": {
      const n = toNumeric(v)!;
      if (typeof n === "number" && Number.isInteger(n) && Math.abs(n) <= 9007199254740991) return BigInt(n);
      return n;
    }
  }
}

export function typeName(v: Value): string {
  if (v === null) return "null";
  if (typeof v === "bigint") return "integer";
  if (typeof v === "number") return "real";
  return "text";
}

/** Stable string key for hashing tuples of values (GROUP BY, DISTINCT, UNIQUE, set operations). */
export function keyOf(values: readonly Value[]): string {
  let out = "";
  for (const v of values) {
    if (v === null) out += "n;";
    else if (typeof v === "string") out += `s${v.length}:${v};`;
    else {
      // 1 and 1.0 are equal in SQL, so numbers share one canonical form
      const asInt = typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= 9007199254740991 ? BigInt(v) : v;
      out += typeof asInt === "bigint" ? `i${asInt};` : `r${asInt};`;
    }
  }
  return out;
}
