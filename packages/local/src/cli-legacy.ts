#!/usr/bin/env node
import { main } from "./cli-main.js";

// M9-1-2: 옛 bin 별칭 (`procforge`). stderr에 제거 경고를 1회 출력한 뒤
// `proof`와 같은 본체 main()을 호출한다. cli-main.ts는 실행 시 부수효과가
// 없으므로 경고가 항상 먼저 나간다 (static import 평가 순서 문제 없음).
// procforge-local(MCP stdio)에는 경고를 넣지 않는다.
// 이유: stdout이 JSON-RPC 프로토콜 채널이라 경고 한 줄이 섞이면 프로토콜이 깨진다.
process.stderr.write(
  "warning: 'procforge' 명령은 옛 이름이다. 'proof'를 사용하라. (별칭은 당분간 유지된다.)\n",
);
process.exitCode = await main();
