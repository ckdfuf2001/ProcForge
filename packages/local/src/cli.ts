#!/usr/bin/env node
import { main } from "./cli-main.js";

// M9-1-2-fix: `proof` 진입점. 본체는 cli-main.ts의 main()이며 이 파일은 실행만 담당한다.
process.exitCode = await main();
