import { describe, expect, test } from "bun:test";
import { SqlSyntaxError, tokenize } from "../src/lexer";

const kinds = (sql: string) => tokenize(sql).map((t) => `${t.kind}:${t.value}`);

describe("tokenize", () => {
  test("keywords, identifiers and punctuation", () => {
    expect(kinds("SELECT a, b FROM t;")).toEqual([
      "ident:SELECT", "ident:a", "op:,", "ident:b", "ident:FROM", "ident:t", "op:;", "eof:",
    ]);
    expect(tokenize("select")[0]!.upper).toBe("SELECT");
  });

  test("numbers", () => {
    const toks = tokenize("42 3.14 .5 1e3 2E-2 0x1F");
    expect(toks.slice(0, 6).map((t) => [t.value, t.isInteger])).toEqual([
      ["42", true], ["3.14", false], [".5", false], ["1e3", false], ["2E-2", false], ["31", true],
    ]);
  });

  test("strings with doubled quotes", () => {
    expect(tokenize("'it''s'")[0]!.value).toBe("it's");
    expect(tokenize("''")[0]!.value).toBe("");
  });

  test("quoted identifiers are never keywords", () => {
    for (const src of ['"select"', "`select`", "[select]"]) {
      const t = tokenize(src)[0]!;
      expect(t.kind).toBe("ident");
      expect(t.quoted).toBe(true);
      expect(t.value).toBe("select");
      expect(t.upper).toBe("select");
    }
    expect(tokenize('"a""b"')[0]!.value).toBe('a"b');
  });

  test("operators prefer the longest match", () => {
    expect(kinds("a<=b<>c!=d||e==f")).toEqual([
      "ident:a", "op:<=", "ident:b", "op:<>", "ident:c", "op:!=", "ident:d", "op:||", "ident:e", "op:==", "ident:f", "eof:",
    ]);
  });

  test("comments are skipped", () => {
    expect(kinds("SELECT -- hi\n 1 /* multi\nline */ + 2")).toEqual([
      "ident:SELECT", "number:1", "op:+", "number:2", "eof:",
    ]);
  });

  test("parameters", () => {
    expect(kinds("? ?2 :name @x $y")).toEqual(["param:", "param:2", "param::name", "param:@x", "param:$y", "eof:"]);
  });

  test("tracks source offsets", () => {
    const [a, b] = tokenize("  foo  'bar'");
    expect([a!.start, a!.end, b!.start, b!.end]).toEqual([2, 5, 7, 12]);
  });

  test("errors", () => {
    expect(() => tokenize("'abc")).toThrow(SqlSyntaxError);
    expect(() => tokenize("/* x")).toThrow(SqlSyntaxError);
    expect(() => tokenize("12abc")).toThrow(SqlSyntaxError);
    expect(() => tokenize("#")).toThrow(/unexpected character/);
  });
});
