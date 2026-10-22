#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const cli = join(repo, "packages", "local", "dist", "cli.js");
const temp = join(tmpdir(), "opencode");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg("--port", "55633"));
const timeoutMs = Number(arg("--timeout", "20")) * 1000;
const shouldOpen = process.argv.includes("--open");
const log = join(temp, "pf-ui-" + port + ".log");
const errLog = join(temp, "pf-ui-" + port + ".err.log");
const state = join(temp, "pf-ui-" + port + ".json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stopPort(ownerPort) {
  if (process.platform === "win32") {
    let out = "";
    try {
      out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
    } catch {
      return;
    }
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      const cols = line.trim().split(/\s+/);
      if (!cols[1]?.endsWith(":" + ownerPort)) continue;
      const pid = Number(cols.at(-1));
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    return;
  }
  try {
    execFileSync("sh", ["-c", "lsof -tiTCP:" + ownerPort + " -sTCP:LISTEN | xargs -r kill"]);
  } catch {
    // already gone
  }
}

if (!existsSync(cli)) {
  console.error("UI CLI not found: " + cli + " (run pnpm build first)");
  process.exit(1);
}

mkdirSync(temp, { recursive: true });
stopPort(port);
await sleep(300);

const outFd = openSync(log, "w");
const errFd = openSync(errLog, "w");
const args = [cli, "ui", "--port", String(port)];
if (shouldOpen) args.push("--open");

const child = spawn(process.execPath, args, {
  cwd: repo,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", outFd, errFd],
});
closeSync(outFd);
closeSync(errFd);

let url;
let token;
const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline && child.exitCode === null) {
  await sleep(250);
  if (!existsSync(log)) continue;
  const line = readFileSync(log, "utf8")
    .split(/\r?\n/)
    .reverse()
    .find((l) => /^ui:\s+http:\/\/127\.0\.0\.1:/.test(l));
  if (!line) continue;
  const m = /^ui:\s+(http:\/\/127\.0\.0\.1:\d+#t=([0-9a-f]+))/.exec(line);
  if (m) {
    url = m[1];
    token = m[2];
    break;
  }
}

if (!url || !token) {
  const err = existsSync(errLog) ? readFileSync(errLog, "utf8") : "";
  if (child.exitCode === null) {
    try {
      process.kill(child.pid);
    } catch {
      // already gone
    }
  }
  console.error("Timed out waiting for UI URL. " + err);
  process.exit(1);
}

writeFileSync(
  state,
  JSON.stringify(
    {
      pid: child.pid,
      port,
      url,
      token,
      log,
      errorLog: errLog,
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);

console.log("PID=" + child.pid);
console.log("URL=" + url);
console.log("TOKEN=" + token);
console.log("STATE=" + state);

if (shouldOpen) {
  spawn("cmd", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

child.unref();
process.exit(0);
