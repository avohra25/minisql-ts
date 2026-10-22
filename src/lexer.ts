/**
 * SQL tokenizer.
 *
 * Keywords are not distinguished from identifiers here: an unquoted word is an
 * `ident` token whose `upper` field holds its upper-cased spelling, and the
 * parser decides from context whether it is a keyword. Quoted identifiers
 * ("name", `name` or [name]) are flagged so they are never treated as keywords.
 */

export type TokenKind = "ident" | "number" | "string" | "param" | "op" | "eof";

export interface Token {
  kind: TokenKind;
  /** Decoded value: identifier name, string contents, number text, operator, or param name. */
  value: string;
  /** Upper-cased value, handy for keyword checks (only meaningful for unquoted idents). */
  upper: string;
  /** True for "quoted", `quoted` or [quoted] identifiers. */
  quoted: boolean;
  /** For numbers: true when the literal has no decimal point or exponent. */
  isInteger: boolean;
  /** Byte offsets into the source, [start, end). */
  start: number;
  end: number;
}

export class SqlSyntaxError extends Error {
  constructor(message: string, readonly position: number) {
    super(`${message} (at offset ${position})`);
    this.name = "SqlSyntaxError";
  }
}

const TWO_CHAR_OPS = new Set(["<=", ">=", "<>", "!=", "==", "||", "<<", ">>"]);
const ONE_CHAR_OPS = new Set([..."(),;.*+-/%<>=&|~"]);

const isDigit = (c: string) => c >= "0" && c <= "9";
const isIdentStart = (c: string) => /[A-Za-z_\u0080-\uffff]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_$\u0080-\uffff]/.test(c);

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;

  const push = (kind: TokenKind, value: string, start: number, extra: Partial<Token> = {}) => {
    tokens.push({
      kind,
      value,
      upper: kind === "ident" && !extra.quoted ? value.toUpperCase() : value,
      quoted: false,
      isInteger: false,
      start,
      end: i,
      ...extra,
    });
  };

  while (i < n) {
    const c = sql[i]!;
    const start = i;

    // whitespace
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // -- line comment
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    // /* block comment */
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      if (close < 0) throw new SqlSyntaxError("unterminated block comment", start);
      i = close + 2;
      continue;
    }
    // string literal with '' escaping
    if (c === "'") {
      let out = "";
      i++;
      for (;;) {
        if (i >= n) throw new SqlSyntaxError("unterminated string literal", start);
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        out += sql[i++];
      }
      push("string", out, start);
      continue;
    }
    // quoted identifiers
    if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let out = "";
      i++;
      for (;;) {
        if (i >= n) throw new SqlSyntaxError("unterminated quoted identifier", start);
        if (sql[i] === close) {
          if (close !== "]" && sql[i + 1] === close) {
            out += close;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        out += sql[i++];
      }
      push("ident", out, start, { quoted: true });
      continue;
    }
    // numbers: 12, 1.5, .5, 1e10, 0x1F
    if (isDigit(c) || (c === "." && isDigit(sql[i + 1] ?? ""))) {
      if (c === "0" && (sql[i + 1] === "x" || sql[i + 1] === "X")) {
        i += 2;
        while (i < n && /[0-9a-fA-F]/.test(sql[i]!)) i++;
        if (i === start + 2) throw new SqlSyntaxError("malformed hex literal", start);
        push("number", BigInt(sql.slice(start, i)).toString(), start, { isInteger: true });
      } else {
        let isInteger = true;
        while (i < n && isDigit(sql[i]!)) i++;
        if (sql[i] === ".") {
          isInteger = false;
          i++;
          while (i < n && isDigit(sql[i]!)) i++;
        }
        if (sql[i] === "e" || sql[i] === "E") {
          let j = i + 1;
          if (sql[j] === "+" || sql[j] === "-") j++;
          if (!isDigit(sql[j] ?? "")) throw new SqlSyntaxError("malformed number", start);
          isInteger = false;
          i = j;
          while (i < n && isDigit(sql[i]!)) i++;
        }
        if (i < n && isIdentStart(sql[i]!)) throw new SqlSyntaxError("malformed number", start);
        push("number", sql.slice(start, i), start, { isInteger });
      }
      continue;
    }
    // bind parameters: ?  ?3  :name  @name  $name
    if (c === "?") {
      i++;
      while (i < n && isDigit(sql[i]!)) i++;
      push("param", sql.slice(start + 1, i), start);
      continue;
    }
    if ((c === ":" || c === "@" || c === "$") && isIdentStart(sql[i + 1] ?? "")) {
      i++;
      while (i < n && isIdentPart(sql[i]!)) i++;
      push("param", sql.slice(start, i), start);
      continue;
    }
    if (isIdentStart(c)) {
      while (i < n && isIdentPart(sql[i]!)) i++;
      push("ident", sql.slice(start, i), start);
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      i += 2;
      push("op", two, start);
      continue;
    }
    if (ONE_CHAR_OPS.has(c)) {
      i++;
      push("op", c, start);
      continue;
    }
    throw new SqlSyntaxError(`unexpected character ${JSON.stringify(c)}`, start);
  }
  tokens.push({ kind: "eof", value: "", upper: "", quoted: false, isInteger: false, start: n, end: n });
  return tokens;
}
