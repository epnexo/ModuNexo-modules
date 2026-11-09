import { createInterface } from "node:readline/promises";
import type { Prompter } from "./setup.ts";

/** Reads answers from the terminal. A secret is typed without being echoed; without a terminal it is read as a plain line. */
export function terminalPrompter(): Prompter {
  const input = process.stdin;
  const output = process.stderr;
  // Piped input arrives all at once: one reader keeps the lines of the later questions, which a reader per question would drop.
  let piped: AsyncIterator<string> | null = null;
  return {
    async ask(question) {
      if (!input.isTTY) {
        piped ??= createInterface({ input })[Symbol.asyncIterator]();
        output.write(question);
        const next = await piped.next();
        output.write("\n");
        return next.done ? "" : next.value;
      }
      const lines = createInterface({ input, output });
      try {
        return await lines.question(question);
      } finally {
        lines.close();
      }
    },
    askSecret(question) {
      if (!input.isTTY) return this.ask(question);
      return new Promise((resolve, reject) => {
        output.write(question);
        let typed = "";
        input.setRawMode(true);
        input.resume();
        const finish = (done: () => void) => {
          input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          output.write("\n");
          done();
        };
        const onData = (chunk: Buffer) => {
          for (const char of chunk.toString("utf8")) {
            if (char === "\r" || char === "\n") return finish(() => resolve(typed));
            if (char === "\u0003") return finish(() => reject(new Error("cancelled; nothing was saved")));
            if (char === "\u007f" || char === "\b") typed = typed.slice(0, -1);
            else typed += char;
          }
        };
        input.on("data", onData);
      });
    },
  };
}
