#!/usr/bin/env bun
/**
 * minisql command-line shell.
 *
 *   bun src/cli.ts                 interactive REPL
 *   bun src/cli.ts a.sql b.sql     run scripts, then start the REPL if stdin is a terminal
 *   bun src/cli.ts -c "SQL"        run SQL and exit
 *   cat x.sql | bun src/cli.ts     run piped SQL
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Shell } from "./shell";

const shell = new Shell({ readFile: (p) => readFileSync(p, "utf8") });
const print = (s: string) => {
  if (s) console.log(s);
};

const args = process.argv.slice(2);
let ranSomething = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "-h" || a === "--help") {
    console.log("usage: minisql [-c SQL] [-m table|csv|json] [FILE.sql ...]");
    process.exit(0);
  } else if (a === "-c") {
    print(shell.runScript(args[++i] ?? ""));
    ranSomething = true;
  } else if (a === "-m") {
    print(shell.feed(`.mode ${args[++i] ?? ""}`));
  } else {
    print(shell.runScript(readFileSync(a, "utf8")));
    ranSomething = true;
  }
}

if (!process.stdin.isTTY) {
  if (!ranSomething) print(shell.runScript(await Bun.stdin.text()));
} else if (!ranSomething || args.every((a) => a !== "-c")) {
  console.log('minisql - an in-memory SQL engine. Type ".help" for help.');
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: shell.prompt });
  rl.prompt();
  rl.on("line", (line) => {
    print(shell.feed(line));
    if (shell.done) return rl.close();
    rl.setPrompt(shell.prompt);
    rl.prompt();
  });
  rl.on("close", () => process.exit(0));
}
