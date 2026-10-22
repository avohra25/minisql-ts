/**
 * The interactive shell's logic, kept free of I/O so it can be unit tested:
 * feed it lines, get back text to print.
 */
import { Database } from "./database";
import { formatResult, type OutputMode } from "./format";
import { SqlSyntaxError, tokenize } from "./lexer";

const HELP = `Statements end with ';' and may span several lines.
Dot commands:
  .help              show this message
  .tables            list tables
  .schema [TABLE]    show CREATE TABLE statements
  .mode table|csv|json
  .timer on|off      print how long each statement took
  .read FILE         run the statements in FILE
  .quit              exit`;

/** True once `sql` holds at least one complete `;`-terminated statement (or is clearly broken). */
export function isComplete(sql: string): boolean {
  try {
    const toks = tokenize(sql);
    return toks.length >= 2 && toks[toks.length - 2]!.kind === "op" && toks[toks.length - 2]!.value === ";";
  } catch (e) {
    // an unterminated string/comment/identifier needs more input; any other error is reported now
    return !(e instanceof SqlSyntaxError && /unterminated/.test(e.message));
  }
}

export interface ShellOptions {
  readFile?: (path: string) => string;
  now?: () => number;
}

export class Shell {
  readonly db = new Database();
  mode: OutputMode = "table";
  timer = false;
  done = false;
  private buffer = "";

  constructor(private readonly options: ShellOptions = {}) {}

  /** Prompt to show for the next line. */
  get prompt(): string {
    return this.buffer ? "   ...> " : "minisql> ";
  }

  /** Feed one input line; returns output to print (possibly empty). */
  feed(line: string): string {
    if (!this.buffer && line.trim().startsWith(".")) return this.dot(line.trim());
    this.buffer += (this.buffer ? "\n" : "") + line;
    if (!this.buffer.trim()) {
      this.buffer = "";
      return "";
    }
    if (!isComplete(this.buffer)) return "";
    const sql = this.buffer;
    this.buffer = "";
    return this.run(sql);
  }

  /** Run a whole script, e.g. from a file or stdin. */
  runScript(sql: string): string {
    const out: string[] = [];
    for (const line of sql.split(/\r?\n/)) {
      const o = this.feed(line);
      if (o) out.push(o);
      if (this.done) break;
    }
    if (this.buffer.trim()) {
      const rest = this.buffer;
      this.buffer = "";
      out.push(this.run(rest));
    }
    return out.join("\n");
  }

  private run(sql: string): string {
    const now = this.options.now ?? (() => performance.now());
    const out: string[] = [];
    const start = now();
    try {
      for (const r of this.db.execute(sql)) {
        if (r.columns.length) {
          out.push(formatResult(this.mode, r.columns, r.rows));
          if (this.mode === "table") out.push(`(${r.rows.length} row${r.rows.length === 1 ? "" : "s"})`);
        } else if (r.changes) {
          out.push(`(${r.changes} row${r.changes === 1 ? "" : "s"} affected)`);
        }
      }
    } catch (e) {
      out.push(`Error: ${(e as Error).message}`);
    }
    if (this.timer) out.push(`Run time: ${(now() - start).toFixed(3)} ms`);
    return out.join("\n");
  }

  private dot(cmd: string): string {
    const [name, ...args] = cmd.split(/\s+/);
    switch (name) {
      case ".help":
        return HELP;
      case ".quit":
      case ".exit":
        this.done = true;
        return "";
      case ".tables":
        return this.db.tableNames().join("  ");
      case ".schema": {
        const names = args.length ? args : this.db.tableNames();
        try {
          return names.map((n) => this.db.schema(n)).join("\n");
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      }
      case ".mode":
        if (args[0] === "table" || args[0] === "csv" || args[0] === "json") {
          this.mode = args[0];
          return "";
        }
        return "Error: .mode expects table, csv or json";
      case ".timer":
        if (args[0] === "on" || args[0] === "off") {
          this.timer = args[0] === "on";
          return "";
        }
        return "Error: .timer expects on or off";
      case ".read": {
        if (!args[0]) return "Error: .read expects a file name";
        const read = this.options.readFile;
        if (!read) return "Error: .read is not available";
        try {
          return this.runScript(read(args.join(" ")));
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      }
      default:
        return `Error: unknown command ${name} (try .help)`;
    }
  }
}
