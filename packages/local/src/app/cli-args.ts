import { parseArgs } from "node:util";
import { resolve } from "node:path";

// CLI 인자 파싱 (M4.2-4-1). 어댑터는 node:util 직접 import 없이 이 모듈을 쓴다.

export type CliValues = {
  session?: string;
  procedure?: string;
  node?: string;
  mode?: string;
  junit?: string;
  "update-golden"?: boolean;
  "allow-bash"?: boolean;
  "allow-project-read"?: boolean;
  changed?: boolean;
  "procforge-dir"?: string;
  "project-root"?: string;
  redact?: boolean;
  "include-originals"?: boolean;
  out?: string;
  param?: string[];
  discard?: string;
  force?: boolean;
};

export function parseCliArgs(argv: string[]): { values: CliValues; positionals: string[] } {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
      procedure: { type: "string" },
      node: { type: "string" },
      mode: { type: "string", default: "replay" },
      junit: { type: "string" },
      "update-golden": { type: "boolean", default: false },
      "allow-bash": { type: "boolean", default: false },
      "allow-project-read": { type: "boolean", default: false },
      changed: { type: "boolean", default: false },
      "procforge-dir": { type: "string" },
      "project-root": { type: "string" },
      redact: { type: "boolean", default: false },
      "include-originals": { type: "boolean", default: false },
      out: { type: "string" },
      param: { type: "string", multiple: true },
      discard: { type: "string" },
      force: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  return { values: values as CliValues, positionals };
}

export function resolveDirs(
  values: CliValues,
  env: NodeJS.ProcessEnv,
): { projectRoot: string; procforgeDir: string } {
  const projectRoot = resolve(values["project-root"] ?? env.PROCFORGE_PROJECT_ROOT ?? process.cwd());
  const procforgeDir = resolve(values["procforge-dir"] ?? env.PROCFORGE_DIR ?? `${projectRoot}/.procforge`);
  return { projectRoot, procforgeDir };
}
