import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { childEnv } from "./config.js";

export interface RunOptions {
  /** Called with each complete stdout line as it arrives. */
  onLine?: (line: string) => void;
  /** Lets the caller keep a handle to kill the process. */
  onSpawn?: (child: ChildProcess) => void;
  /** Copy everything the program prints (stdout and stderr) into this file. */
  logFile?: string;
}

/**
 * Run a program with an argument array. Never goes through a shell, so a pasted URL
 * containing & | " or ; cannot run anything.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: childEnv, shell: false, windowsHide: true });
    opts.onSpawn?.(child);
    if (opts.logFile) {
      const log = fs.createWriteStream(opts.logFile);
      log.write(`> ${cmd} ${args.join(" ")}\n\n`);
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.on("close", (code) => log.end(`\n< exit code ${code}\n`));
    }
    let out = "";
    let err = "";
    let partial = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (!opts.onLine) return;
      partial += chunk;
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const l of lines) opts.onLine(l);
    });
    child.stderr.on("data", (chunk: string) => {
      err += chunk;
      if (err.length > 20000) err = err.slice(-20000);
    });
    child.on("error", (e) =>
      reject(new Error(`Could not start ${cmd}: ${e.message}. Run scripts/setup.ps1 or check config.json.`)),
    );
    child.on("close", (code) => {
      if (opts.onLine && partial) opts.onLine(partial);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited with code ${code}: ${err.trim().split(/\r?\n/).slice(-5).join(" | ")}`));
    });
  });
}
