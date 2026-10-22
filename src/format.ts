/** Render query results for humans (box tables) and machines (CSV, JSON). */
import { realToText, type Value } from "./values";

export type OutputMode = "table" | "csv" | "json";

/** Text for one cell. INTEGERs arrive as bigint and REALs as number, so 1.0 prints as "1.0". */
export function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return realToText(v);
  return String(v);
}

const width = (s: string) => Array.from(s).length;

/** A unicode box table; numbers are right-aligned. */
export function formatTable(columns: string[], rows: readonly (readonly unknown[])[]): string {
  if (columns.length === 0) return "";
  const cells = rows.map((r) => r.map((v) => displayValue(v).replace(/\n/g, "\\n")));
  const widths = columns.map((c, i) => Math.max(width(c), ...cells.map((r) => width(r[i]!))));
  const numeric = columns.map((_, i) => rows.length > 0 && rows.every((r) => r[i] === null || typeof r[i] === "number" || typeof r[i] === "bigint"));
  const pad = (s: string, i: number) => {
    const fill = " ".repeat(widths[i]! - width(s));
    return numeric[i] ? fill + s : s + fill;
  };
  const line = (l: string, m: string, r: string) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const out = [line("┌", "┬", "┐"), "│ " + columns.map((c, i) => c + " ".repeat(widths[i]! - width(c))).join(" │ ") + " │"];
  out.push(line("├", "┼", "┤"));
  for (const r of cells) out.push("│ " + r.map(pad).join(" │ ") + " │");
  out.push(line("└", "┴", "┘"));
  return out.join("\n");
}

export function formatCsv(columns: string[], rows: readonly (readonly unknown[])[]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = displayValue(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [columns.map(esc), ...rows.map((r) => r.map(esc))].map((r) => r.join(",")).join("\n");
}

export function formatJson(columns: string[], rows: readonly (readonly unknown[])[]): string {
  const objs = rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])));
  // integers become JSON numbers when they fit exactly, strings otherwise
  return JSON.stringify(objs, (_k, v) => (typeof v === "bigint" ? (Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()) : v), 2);
}

export function formatResult(mode: OutputMode, columns: string[], rows: readonly (readonly Value[])[]): string {
  switch (mode) {
    case "csv":
      return formatCsv(columns, rows);
    case "json":
      return formatJson(columns, rows);
    default:
      return formatTable(columns, rows);
  }
}
