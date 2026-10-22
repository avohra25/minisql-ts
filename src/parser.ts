/**
 * Recursive-descent SQL parser. Operator precedence follows SQLite:
 *
 *   OR < AND < NOT < (= == != <> IS IN LIKE BETWEEN) < (< <= > >=)
 *      < (& | << >>) < (+ -) < (* / %) < || < unary (- + ~) < primary
 */
import type {
  BinaryOp, ColumnDef, CompoundOp, CreateTableStmt, Expr, FromItem, OrderTerm,
  SelectCore, SelectItem, SelectStmt, Statement,
} from "./ast";
import { SqlSyntaxError, tokenize, type Token } from "./lexer";

/** Words that can never be used as bare aliases or identifiers. */
const RESERVED = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET", "UNION", "INTERSECT",
  "EXCEPT", "JOIN", "INNER", "LEFT", "CROSS", "OUTER", "ON", "USING", "AND", "OR", "NOT", "AS",
  "BY", "INSERT", "UPDATE", "DELETE", "SET", "VALUES", "INTO", "CREATE", "DROP", "TABLE", "CASE",
  "WHEN", "THEN", "ELSE", "END", "IS", "IN", "LIKE", "BETWEEN", "NULL", "DISTINCT", "ALL",
  "EXISTS", "CAST", "ASC", "DESC", "NATURAL", "DEFAULT", "PRIMARY", "UNIQUE", "CHECK",
]);

export class Parser {
  private tokens: Token[];
  private pos = 0;
  private paramCounter = 0;

  constructor(private readonly sql: string) {
    this.tokens = tokenize(sql);
  }

  // ---------------------------------------------------------------- helpers

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.pos++;
    return t;
  }

  private isKw(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === "ident" && !t.quoted && t.upper === word;
  }

  private acceptKw(...words: string[]): boolean {
    for (let i = 0; i < words.length; i++) if (!this.isKw(words[i]!, i)) return false;
    this.pos += words.length;
    return true;
  }

  private expectKw(...words: string[]): void {
    if (!this.acceptKw(...words)) this.fail(`expected ${words.join(" ")}`);
  }

  private isOp(op: string): boolean {
    const t = this.peek();
    return t.kind === "op" && t.value === op;
  }

  private acceptOp(op: string): boolean {
    if (!this.isOp(op)) return false;
    this.pos++;
    return true;
  }

  private expectOp(op: string): void {
    if (!this.acceptOp(op)) this.fail(`expected '${op}'`);
  }

  private fail(message: string): never {
    const t = this.peek();
    const near = t.kind === "eof" ? "end of input" : `'${this.sql.slice(t.start, t.end)}'`;
    throw new SqlSyntaxError(`${message} near ${near}`, t.start);
  }

  /** Identifier (quoted, or unquoted and not reserved). */
  private identifier(what = "identifier"): string {
    const t = this.peek();
    if (t.kind === "ident" && (t.quoted || !RESERVED.has(t.upper))) {
      this.pos++;
      return t.value;
    }
    return this.fail(`expected ${what}`);
  }

  private isIdentifier(offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === "ident" && (t.quoted || !RESERVED.has(t.upper));
  }

  /** Throws unless every token has been consumed. */
  expectEnd(): void {
    if (this.peek().kind !== "eof") this.fail("unexpected trailing input");
  }

  // ------------------------------------------------------------- statements

  parseScript(): Statement[] {
    const out: Statement[] = [];
    for (;;) {
      while (this.acceptOp(";"));
      if (this.peek().kind === "eof") return out;
      out.push(this.statement());
      if (this.peek().kind !== "eof") this.expectOp(";");
    }
  }

  statement(): Statement {
    if (this.isKw("SELECT") || this.isKw("VALUES") || this.isOp("(")) return this.select();
    if (this.acceptKw("CREATE")) return this.createTable();
    if (this.acceptKw("DROP")) {
      this.expectKw("TABLE");
      const ifExists = this.acceptKw("IF", "EXISTS");
      return { kind: "dropTable", name: this.identifier("table name"), ifExists };
    }
    if (this.isKw("INSERT") || this.isKw("REPLACE")) return this.insert();
    if (this.acceptKw("UPDATE")) {
      const table = this.identifier("table name");
      this.expectKw("SET");
      const set: { column: string; value: Expr }[] = [];
      do {
        const column = this.identifier("column name");
        this.expectOp("=");
        set.push({ column, value: this.expr() });
      } while (this.acceptOp(","));
      const where = this.acceptKw("WHERE") ? this.expr() : undefined;
      return { kind: "update", table, set, where };
    }
    if (this.acceptKw("DELETE")) {
      this.expectKw("FROM");
      const table = this.identifier("table name");
      const where = this.acceptKw("WHERE") ? this.expr() : undefined;
      return { kind: "delete", table, where };
    }
    if (this.acceptKw("BEGIN")) {
      this.acceptKw("TRANSACTION");
      return { kind: "begin" };
    }
    if (this.acceptKw("COMMIT") || this.acceptKw("END")) {
      this.acceptKw("TRANSACTION");
      return { kind: "commit" };
    }
    if (this.acceptKw("ROLLBACK")) {
      this.acceptKw("TRANSACTION");
      return { kind: "rollback" };
    }
    return this.fail("expected a statement");
  }

  private createTable(): CreateTableStmt {
    this.expectKw("TABLE");
    const ifNotExists = this.acceptKw("IF", "NOT", "EXISTS");
    const name = this.identifier("table name");
    const stmt: CreateTableStmt = { kind: "createTable", name, ifNotExists, columns: [], uniques: [] };
    if (this.acceptKw("AS")) {
      stmt.asSelect = this.select();
      return stmt;
    }
    this.expectOp("(");
    do {
      if (this.acceptKw("PRIMARY", "KEY")) {
        if (stmt.primaryKey) this.fail("table has more than one primary key");
        stmt.primaryKey = this.nameList();
      } else if (this.acceptKw("UNIQUE")) {
        stmt.uniques.push(this.nameList());
      } else {
        stmt.columns.push(this.columnDef());
      }
    } while (this.acceptOp(","));
    this.expectOp(")");
    const pkCols = stmt.columns.filter((c) => c.primaryKey).length + (stmt.primaryKey ? 1 : 0);
    if (pkCols > 1) throw new SqlSyntaxError(`table "${name}" has more than one primary key`, 0);
    return stmt;
  }

  private nameList(): string[] {
    this.expectOp("(");
    const names = [this.identifier("column name")];
    while (this.acceptOp(",")) names.push(this.identifier("column name"));
    this.expectOp(")");
    return names;
  }

  private columnDef(): ColumnDef {
    const name = this.identifier("column name");
    // type name: zero or more words, optionally followed by (n) or (n, m)
    const words: string[] = [];
    while (this.peek().kind === "ident" && !this.peek().quoted && !this.isConstraintStart()) {
      words.push(this.next().upper);
    }
    if (words.length && this.acceptOp("(")) {
      while (!this.acceptOp(")")) {
        if (this.peek().kind === "eof") this.fail("unterminated type");
        this.next();
      }
    }
    const col: ColumnDef = { name, type: words.join(" "), primaryKey: false, notNull: false, unique: false };
    for (;;) {
      if (this.acceptKw("PRIMARY", "KEY")) {
        col.primaryKey = true;
        if (!this.acceptKw("ASC")) this.acceptKw("DESC");
        this.acceptKw("AUTOINCREMENT");
      } else if (this.acceptKw("NOT", "NULL")) col.notNull = true;
      else if (this.acceptKw("NULL")) continue;
      else if (this.acceptKw("UNIQUE")) col.unique = true;
      else if (this.acceptKw("DEFAULT")) {
        col.default = this.isOp("(") ? this.primary() : this.unary();
      } else break;
    }
    return col;
  }

  private isConstraintStart(): boolean {
    return ["PRIMARY", "NOT", "NULL", "UNIQUE", "DEFAULT", "CHECK", "REFERENCES"].some((w) => this.isKw(w));
  }

  private insert(): Statement {
    let orReplace = false;
    let orIgnore = false;
    if (this.acceptKw("REPLACE")) orReplace = true;
    else {
      this.expectKw("INSERT");
      if (this.acceptKw("OR", "REPLACE")) orReplace = true;
      else if (this.acceptKw("OR", "IGNORE")) orIgnore = true;
    }
    this.expectKw("INTO");
    const table = this.identifier("table name");
    let columns: string[] | undefined;
    if (this.isOp("(") && !this.isKw("SELECT", 1)) columns = this.nameList();
    if (this.acceptKw("DEFAULT", "VALUES")) {
      return { kind: "insert", table, columns, source: { kind: "defaults" }, orReplace, orIgnore };
    }
    if (this.acceptKw("VALUES")) {
      const rows = this.valuesRows();
      return { kind: "insert", table, columns, source: { kind: "values", rows }, orReplace, orIgnore };
    }
    return { kind: "insert", table, columns, source: { kind: "select", query: this.select() }, orReplace, orIgnore };
  }

  private valuesRows(): Expr[][] {
    const rows: Expr[][] = [];
    do {
      this.expectOp("(");
      const row = [this.expr()];
      while (this.acceptOp(",")) row.push(this.expr());
      this.expectOp(")");
      if (rows.length && row.length !== rows[0]!.length) {
        this.fail("all VALUES rows must have the same number of terms");
      }
      rows.push(row);
    } while (this.acceptOp(","));
    return rows;
  }

  // ----------------------------------------------------------------- SELECT

  select(): SelectStmt {
    const core = this.selectCore();
    const compounds: { op: CompoundOp; core: SelectCore }[] = [];
    for (;;) {
      let op: CompoundOp;
      if (this.acceptKw("UNION", "ALL")) op = "UNION ALL";
      else if (this.acceptKw("UNION")) op = "UNION";
      else if (this.acceptKw("INTERSECT")) op = "INTERSECT";
      else if (this.acceptKw("EXCEPT")) op = "EXCEPT";
      else break;
      compounds.push({ op, core: this.selectCore() });
    }
    const orderBy: OrderTerm[] = [];
    if (this.acceptKw("ORDER", "BY")) {
      do {
        const expr = this.expr();
        let desc = false;
        if (this.acceptKw("DESC")) desc = true;
        else this.acceptKw("ASC");
        let nullsFirst: boolean | undefined;
        if (this.acceptKw("NULLS", "FIRST")) nullsFirst = true;
        else if (this.acceptKw("NULLS", "LAST")) nullsFirst = false;
        orderBy.push({ expr, desc, nullsFirst });
      } while (this.acceptOp(","));
    }
    let limit: Expr | undefined;
    let offset: Expr | undefined;
    if (this.acceptKw("LIMIT")) {
      limit = this.expr();
      if (this.acceptKw("OFFSET")) offset = this.expr();
      else if (this.acceptOp(",")) {
        // LIMIT offset, count
        offset = limit;
        limit = this.expr();
      }
    }
    return { kind: "select", core, compounds, orderBy, limit, offset };
  }

  private selectCore(): SelectCore {
    if (this.acceptKw("VALUES")) {
      // VALUES (..),(..) is sugar for SELECT .. UNION ALL SELECT ..; we model it as a
      // derived table so column names come out as column1, column2, ...
      const rows = this.valuesRows();
      const query = valuesAsSelect(rows);
      return {
        distinct: false,
        columns: [{ kind: "star" }],
        from: { kind: "subquery", query, alias: "values" },
        groupBy: [],
      };
    }
    if (this.acceptOp("(")) {
      // parenthesised select used as a compound operand: SELECT ... UNION (SELECT ...)
      const inner = this.select();
      this.expectOp(")");
      return { distinct: false, columns: [{ kind: "star" }], from: { kind: "subquery", query: inner, alias: "subquery" }, groupBy: [] };
    }
    this.expectKw("SELECT");
    let distinct = false;
    if (this.acceptKw("DISTINCT")) distinct = true;
    else this.acceptKw("ALL");
    const columns: SelectItem[] = [];
    do columns.push(this.selectItem());
    while (this.acceptOp(","));
    const core: SelectCore = { distinct, columns, groupBy: [] };
    if (this.acceptKw("FROM")) core.from = this.fromClause();
    if (this.acceptKw("WHERE")) core.where = this.expr();
    if (this.acceptKw("GROUP", "BY")) {
      do core.groupBy.push(this.expr());
      while (this.acceptOp(","));
    }
    if (this.acceptKw("HAVING")) core.having = this.expr();
    return core;
  }

  private selectItem(): SelectItem {
    if (this.acceptOp("*")) return { kind: "star" };
    if (this.isIdentifier() && this.peek(1).value === "." && this.peek(1).kind === "op" && this.peek(2).value === "*" && this.peek(2).kind === "op") {
      const table = this.identifier();
      this.pos += 2;
      return { kind: "star", table };
    }
    const startTok = this.peek();
    const expr = this.expr();
    const text = this.sql.slice(startTok.start, this.tokens[this.pos - 1]!.end);
    let alias: string | undefined;
    if (this.acceptKw("AS")) alias = this.identifier("alias");
    else if (this.isIdentifier()) alias = this.identifier();
    else if (this.peek().kind === "string") alias = this.next().value;
    return { kind: "expr", expr, alias, text };
  }

  private fromClause(): FromItem {
    let left = this.tableOrSubquery();
    for (;;) {
      if (this.acceptOp(",")) {
        left = { kind: "join", type: "CROSS", left, right: this.tableOrSubquery() };
        continue;
      }
      let type: "INNER" | "LEFT" | "CROSS" | undefined;
      if (this.acceptKw("JOIN") || this.acceptKw("INNER", "JOIN")) type = "INNER";
      else if (this.acceptKw("LEFT", "JOIN") || this.acceptKw("LEFT", "OUTER", "JOIN")) type = "LEFT";
      else if (this.acceptKw("CROSS", "JOIN")) type = "CROSS";
      if (!type) return left;
      const right = this.tableOrSubquery();
      if (this.acceptKw("ON")) left = { kind: "join", type, left, right, on: this.expr() };
      else if (this.acceptKw("USING")) left = { kind: "join", type, left, right, using: this.nameList() };
      else if (type === "CROSS" || type === "INNER") left = { kind: "join", type: "CROSS", left, right };
      else this.fail("LEFT JOIN requires ON or USING");
    }
  }

  private tableOrSubquery(): FromItem {
    if (this.acceptOp("(")) {
      if (this.isKw("SELECT") || this.isKw("VALUES")) {
        const query = this.select();
        this.expectOp(")");
        this.acceptKw("AS");
        const alias = this.isIdentifier() ? this.identifier() : `subquery${this.pos}`;
        return { kind: "subquery", query, alias };
      }
      const inner = this.fromClause();
      this.expectOp(")");
      return inner;
    }
    const name = this.identifier("table name");
    let alias: string | undefined;
    if (this.acceptKw("AS")) alias = this.identifier("alias");
    else if (this.isIdentifier()) alias = this.identifier();
    return { kind: "table", name, alias };
  }

  // ------------------------------------------------------------ expressions

  expr(): Expr {
    return this.orExpr();
  }

  private orExpr(): Expr {
    let left = this.andExpr();
    while (this.acceptKw("OR")) left = { kind: "binary", op: "OR", left, right: this.andExpr() };
    return left;
  }

  private andExpr(): Expr {
    let left = this.notExpr();
    while (this.acceptKw("AND")) left = { kind: "binary", op: "AND", left, right: this.notExpr() };
    return left;
  }

  private notExpr(): Expr {
    if (this.acceptKw("NOT")) return { kind: "unary", op: "NOT", expr: this.notExpr() };
    return this.equality();
  }

  private equality(): Expr {
    let left = this.comparison();
    for (;;) {
      const t = this.peek();
      if (t.kind === "op" && (t.value === "=" || t.value === "==" || t.value === "!=" || t.value === "<>")) {
        this.pos++;
        const op: BinaryOp = t.value === "=" || t.value === "==" ? "=" : "!=";
        left = { kind: "binary", op, left, right: this.comparison() };
        continue;
      }
      if (this.acceptKw("ISNULL")) {
        left = { kind: "isNull", expr: left, not: false };
        continue;
      }
      if (this.acceptKw("NOTNULL") || this.acceptKw("NOT", "NULL")) {
        left = { kind: "isNull", expr: left, not: true };
        continue;
      }
      if (this.acceptKw("IS")) {
        const not = this.acceptKw("NOT");
        if (this.acceptKw("NULL")) left = { kind: "isNull", expr: left, not };
        else left = { kind: "is", left, right: this.comparison(), not };
        continue;
      }
      const not = this.isKw("NOT") && (this.isKw("IN", 1) || this.isKw("LIKE", 1) || this.isKw("BETWEEN", 1));
      if (not) this.pos++;
      if (this.acceptKw("IN")) {
        left = this.inTail(left, not);
        continue;
      }
      if (this.acceptKw("LIKE")) {
        const pattern = this.comparison();
        const escape = this.acceptKw("ESCAPE") ? this.comparison() : undefined;
        left = { kind: "like", expr: left, pattern, escape, not };
        continue;
      }
      if (this.acceptKw("BETWEEN")) {
        const low = this.comparison();
        this.expectKw("AND");
        const high = this.comparison();
        left = { kind: "between", expr: left, low, high, not };
        continue;
      }
      if (not) this.fail("expected IN, LIKE or BETWEEN after NOT");
      return left;
    }
  }

  private inTail(expr: Expr, not: boolean): Expr {
    this.expectOp("(");
    if (this.isKw("SELECT") || this.isKw("VALUES")) {
      const query = this.select();
      this.expectOp(")");
      return { kind: "inSelect", expr, query, not };
    }
    const list: Expr[] = [];
    if (!this.isOp(")")) {
      do list.push(this.expr());
      while (this.acceptOp(","));
    }
    this.expectOp(")");
    return { kind: "inList", expr, list, not };
  }

  private comparison(): Expr {
    let left = this.bitwise();
    for (;;) {
      const t = this.peek();
      if (t.kind === "op" && (t.value === "<" || t.value === "<=" || t.value === ">" || t.value === ">=")) {
        this.pos++;
        left = { kind: "binary", op: t.value, left, right: this.bitwise() };
      } else return left;
    }
  }

  private bitwise(): Expr {
    let left = this.additive();
    for (;;) {
      const t = this.peek();
      if (t.kind === "op" && (t.value === "&" || t.value === "|" || t.value === "<<" || t.value === ">>")) {
        this.pos++;
        left = { kind: "binary", op: t.value, left, right: this.additive() };
      } else return left;
    }
  }

  private additive(): Expr {
    let left = this.multiplicative();
    for (;;) {
      const t = this.peek();
      if (t.kind === "op" && (t.value === "+" || t.value === "-")) {
        this.pos++;
        left = { kind: "binary", op: t.value, left, right: this.multiplicative() };
      } else return left;
    }
  }

  private multiplicative(): Expr {
    let left = this.concat();
    for (;;) {
      const t = this.peek();
      if (t.kind === "op" && (t.value === "*" || t.value === "/" || t.value === "%")) {
        this.pos++;
        left = { kind: "binary", op: t.value, left, right: this.concat() };
      } else return left;
    }
  }

  private concat(): Expr {
    let left = this.unary();
    while (this.acceptOp("||")) left = { kind: "binary", op: "||", left, right: this.unary() };
    return left;
  }

  private unary(): Expr {
    const t = this.peek();
    if (t.kind === "op" && (t.value === "-" || t.value === "+" || t.value === "~")) {
      this.pos++;
      const lit = this.peek();
      if (t.value === "-" && lit.kind === "number" && lit.isInteger) {
        // fold here so -9223372036854775808 (INT64_MIN) stays an exact integer
        this.pos++;
        const v = -BigInt(lit.value);
        return { kind: "literal", value: v < -9223372036854775808n ? Number(v) : v };
      }
      const operand = this.unary();
      // fold negative numeric literals so -9223372036854775808 stays an integer
      if (t.value === "-" && operand.kind === "literal" && typeof operand.value === "bigint") {
        return { kind: "literal", value: -operand.value };
      }
      if (t.value === "-" && operand.kind === "literal" && typeof operand.value === "number") {
        return { kind: "literal", value: -operand.value };
      }
      return { kind: "unary", op: t.value, expr: operand };
    }
    return this.primary();
  }

  private primary(): Expr {
    const t = this.peek();
    if (t.kind === "number") {
      this.pos++;
      if (t.isInteger) {
        const v = BigInt(t.value);
        // out-of-range integer literals become reals, as in SQLite
        return { kind: "literal", value: v > 9223372036854775807n ? Number(t.value) : v };
      }
      return { kind: "literal", value: Number(t.value) };
    }
    if (t.kind === "string") {
      this.pos++;
      return { kind: "literal", value: t.value };
    }
    if (t.kind === "param") {
      this.pos++;
      if (t.value === "") return { kind: "param", key: ++this.paramCounter };
      if (/^\d+$/.test(t.value)) {
        const n = Number(t.value);
        this.paramCounter = Math.max(this.paramCounter, n);
        return { kind: "param", key: n };
      }
      return { kind: "param", key: t.value };
    }
    if (this.acceptOp("(")) {
      if (this.isKw("SELECT") || this.isKw("VALUES")) {
        const query = this.select();
        this.expectOp(")");
        return { kind: "subquery", query };
      }
      const e = this.expr();
      this.expectOp(")");
      return e;
    }
    if (t.kind === "ident" && !t.quoted) {
      switch (t.upper) {
        case "NULL":
          this.pos++;
          return { kind: "literal", value: null };
        case "TRUE":
        case "FALSE":
          if (this.peek(1).value !== "(") {
            this.pos++;
            return { kind: "literal", value: t.upper === "TRUE" ? 1n : 0n };
          }
          break;
        case "CURRENT_TIMESTAMP":
          this.pos++;
          return { kind: "call", name: "datetime", args: [{ kind: "literal", value: "now" }], star: false, distinct: false };
        case "EXISTS": {
          this.pos++;
          this.expectOp("(");
          const query = this.select();
          this.expectOp(")");
          return { kind: "exists", query, not: false };
        }
        case "NOT":
          if (this.isKw("EXISTS", 1)) {
            this.pos += 2;
            this.expectOp("(");
            const query = this.select();
            this.expectOp(")");
            return { kind: "exists", query, not: true };
          }
          break;
        case "CASE":
          return this.caseExpr();
        case "CAST": {
          this.pos++;
          this.expectOp("(");
          const expr = this.expr();
          this.expectKw("AS");
          const words: string[] = [];
          while (this.peek().kind === "ident") words.push(this.next().upper);
          if (!words.length) this.fail("expected type name");
          if (this.acceptOp("(")) while (!this.acceptOp(")")) this.next();
          this.expectOp(")");
          return { kind: "cast", expr, type: words.join(" ") };
        }
      }
    }
    if (t.kind === "ident") {
      // function call?
      if (this.peek(1).kind === "op" && this.peek(1).value === "(" && !t.quoted) {
        this.pos += 2;
        const name = t.value.toLowerCase();
        if (this.acceptOp("*")) {
          this.expectOp(")");
          return { kind: "call", name, args: [], star: true, distinct: false };
        }
        const distinct = this.acceptKw("DISTINCT");
        const args: Expr[] = [];
        if (!this.isOp(")")) {
          do args.push(this.expr());
          while (this.acceptOp(","));
        }
        this.expectOp(")");
        return { kind: "call", name, args, star: false, distinct };
      }
      const first = this.identifier("expression");
      if (this.acceptOp(".")) return { kind: "column", table: first, name: this.identifier("column name") };
      return { kind: "column", name: first };
    }
    return this.fail("expected an expression");
  }

  private caseExpr(): Expr {
    this.expectKw("CASE");
    const base = this.isKw("WHEN") ? undefined : this.expr();
    const whens: { when: Expr; then: Expr }[] = [];
    while (this.acceptKw("WHEN")) {
      const when = this.expr();
      this.expectKw("THEN");
      whens.push({ when, then: this.expr() });
    }
    if (!whens.length) this.fail("CASE needs at least one WHEN");
    const elseExpr = this.acceptKw("ELSE") ? this.expr() : undefined;
    this.expectKw("END");
    return { kind: "case", base, whens, else: elseExpr };
  }
}

function valuesAsSelect(rows: Expr[][]): SelectStmt {
  const coreFor = (row: Expr[]): SelectCore => ({
    distinct: false,
    columns: row.map((expr, i) => ({ kind: "expr", expr, alias: `column${i + 1}`, text: `column${i + 1}` })),
    groupBy: [],
  });
  return {
    kind: "select",
    core: coreFor(rows[0]!),
    compounds: rows.slice(1).map((r) => ({ op: "UNION ALL" as const, core: coreFor(r) })),
    orderBy: [],
  };
}

/** Parse a script of `;`-separated statements. */
export function parse(sql: string): Statement[] {
  return new Parser(sql).parseScript();
}

/** Parse exactly one statement (a trailing `;` is allowed). */
export function parseStatement(sql: string): Statement {
  const stmts = parse(sql);
  if (stmts.length !== 1) throw new SqlSyntaxError(`expected exactly one statement, got ${stmts.length}`, 0);
  return stmts[0]!;
}

/** Parse a standalone expression (used by tests and the CLI). */
export function parseExpr(sql: string): Expr {
  const p = new Parser(sql);
  const e = p.expr();
  p.expectEnd();
  return e;
}
