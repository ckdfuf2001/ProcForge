#!/usr/bin/env node
import { main } from "./cli.js";

// M9-1-2: 옛 bin 별칭 (`procforge`). stderr에 제거 경고를 1회 출력한 뒤
// `proof`(dist/cli.js)와 같은 본체 main()을 호출한다. bin이 파일을 가리키므로
// argv[1]이 아닌 파일 자체로 구분한다 (같은 파일 공유로는 구분 불가).
// procforge-local(MCP stdio)에는 경고를 넣지 않는다.
// 이유: stdout이 JSON-RPC 프로토콜 채널이라 경고 한 줄이 섞이면 프로토콜이 깨진다.
process.stderr.write(
  "warning: 'procforge' 명령은 옛 이름이다. 'proof'를 사용하라. (별칭은 당분간 유지된다.)\n",
);
process.exitCode = await main();
