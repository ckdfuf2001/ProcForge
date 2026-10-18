import { spawn } from "node:child_process";

// M7-5-c: 프로세스 트리 종료의 **유일한 구현**.
// script 취소·타임아웃(러너)과 UI 취소(App)가 같은 함수를 쓴다.
// 이전엔 두 벌이었고 한쪽은 SIGTERM 만 보내 SIGTERM 을 무시하는 스크립트를
// 영원히 못 끝냈다.

/** 프로세스가 살아 있는지 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 프로세스 **그룹** 생존 판정.
 * 리더만 보면 안 된다 — 리더는 SIGTERM 에 죽고 손자가 버틸 수 있다.
 * POSIX 의 음수 pid 는 프로세스 그룹을 가리킨다.
 */
export function isGroupAlive(pid: number): boolean {
  if (process.platform === "win32") return isAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return isAlive(pid);
  }
}

/** 유예 시간 (그 뒤에도 살아 있으면 SIGKILL) */
export const GROUP_GRACE_MS = 1500;

/**
 * 프로세스 트리 종료.
 * - Windows: `taskkill /T /F` (자손까지)
 * - POSIX: 그룹 SIGTERM → 유예 → **그룹이 살아 있으면** SIGKILL
 * 유예는 **비동기**다 (이벤트 루프를 막으면 UI 서버·SSE 가 멈춘다).
 */
export async function killProcessTree(
  pid: number,
): Promise<{ killed: number[]; failed: number[] }> {
  const killed: number[] = [];
  const failed: number[] = [];
  if (process.platform === "win32") {
    await new Promise<void>((resolveP) => {
      const c = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      c.on("exit", (code) => {
        if (code === 0) killed.push(pid);
        else failed.push(pid);
        resolveP();
      });
      c.on("error", () => {
        failed.push(pid);
        resolveP();
      });
    });
    return { killed, failed };
  }
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // 이미 종료
      }
    }
  };
  try {
    signal("SIGTERM");
    killed.push(pid);
  } catch {
    failed.push(pid);
    return { killed, failed };
  }
  const deadline = Date.now() + GROUP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!isGroupAlive(pid)) return { killed, failed };
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    signal("SIGKILL");
  } catch {
    // 이미 죽음
  }
  return { killed, failed };
}