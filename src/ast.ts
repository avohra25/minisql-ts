/** Abstract syntax tree for the supported SQL dialect (a practical SQLite subset). */

export type LiteralValue = null | bigint | number | string;

export type Expr =
  | { kind: "literal"; value: LiteralValue }
  | { kind: "column"; table?: string; name: string }
  | { kind: "param"; key: number | string }
  | { kind: "unary"; op: "-" | "+" | "NOT" | "~"; expr: Expr }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr }
  | { kind: "isNull"; expr: Expr; not: boolean }
  | { kind: "is"; left: Expr; right: Expr; not: boolean }
  | { kind: "between"; expr: Expr; low: Expr; high: Expr; not: boolean }
  | { kind: "inList"; expr: Expr; list: Expr[]; not: boolean }
  | { kind: "inSelect"; expr: Expr; query: SelectStmt; not: boolean }
  | { kind: "exists"; query: SelectStmt; not: boolean }
  | { kind: "subquery"; query: SelectStmt }
  | { kind: "like"; expr: Expr; pattern: Expr; escape?: Expr; not: boolean }
  | { kind: "case"; base?: Expr; whens: { when: Expr; then: Expr }[]; else?: Expr }
  | { kind: "cast"; expr: Expr; type: string }
  | { kind: "call"; name: string; args: Expr[]; star: boolean; distinct: boolean };

export type BinaryOp =
  | "OR" | "AND"
  | "=" | "!=" | "<" | "<=" | ">" | ">="
  | "+" | "-" | "*" | "/" | "%" | "||"
  | "&" | "|" | "<<" | ">>";

export type SelectItem =
  | { kind: "star"; table?: string }
  | { kind: "expr"; expr: Expr; alias?: string; text: string };

export type FromItem =
  | { kind: "table"; name: string; alias?: string }
  | { kind: "subquery"; query: SelectStmt; alias: string }
  | { kind: "join"; type: "INNER" | "LEFT" | "CROSS"; left: FromItem; right: FromItem; on?: Expr; using?: string[] };

export interface SelectCore {
  distinct: boolean;
  columns: SelectItem[];
  from?: FromItem;
  where?: Expr;
  groupBy: Expr[];
  having?: Expr;
}

export type CompoundOp = "UNION" | "UNION ALL" | "INTERSECT" | "EXCEPT";

export interface OrderTerm {
  expr: Expr;
  desc: boolean;
  /** undefined = SQLite default (NULLs sort first ascending, last descending). */
  nullsFirst?: boolean;
}

export interface SelectStmt {
  kind: "select";
  core: SelectCore;
  compounds: { op: CompoundOp; core: SelectCore }[];
  orderBy: OrderTerm[];
  limit?: Expr;
  offset?: Expr;
}

export interface ColumnDef {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  unique: boolean;
  default?: Expr;
}

export interface CreateTableStmt {
  kind: "createTable";
  name: string;
  ifNotExists: boolean;
  columns: ColumnDef[];
  /** Table-level PRIMARY KEY / UNIQUE constraints (lists of column names). */
  primaryKey?: string[];
  uniques: string[][];
  asSelect?: SelectStmt;
}

export interface DropTableStmt {
  kind: "dropTable";
  name: string;
  ifExists: boolean;
}

export interface InsertStmt {
  kind: "insert";
  table: string;
  columns?: string[];
  source: { kind: "values"; rows: Expr[][] } | { kind: "select"; query: SelectStmt } | { kind: "defaults" };
  orReplace: boolean;
  orIgnore: boolean;
}

export interface UpdateStmt {
  kind: "update";
  table: string;
  set: { column: string; value: Expr }[];
  where?: Expr;
}

export interface DeleteStmt {
  kind: "delete";
  table: string;
  where?: Expr;
}

export type TransactionStmt = { kind: "begin" } | { kind: "commit" } | { kind: "rollback" };

export type Statement =
  | SelectStmt
  | CreateTableStmt
  | DropTableStmt
  | InsertStmt
  | UpdateStmt
  | DeleteStmt
  | TransactionStmt;
