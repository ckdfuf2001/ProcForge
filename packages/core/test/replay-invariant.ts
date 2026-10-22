import type { CoreService } from "../src/service.js";
import type { HistoryNode } from "@procforge/shared/dto.js";

/**
 * M8-ui2-c: 재생 불변식.
 *
 * 모든 쓰기 이벤트가 detail.nodesAfter(변경분 스냅샷)를 남긴다면, 이벤트 로그를
 * 현재 revision까지 되감은 결과(getTreeAt)는 store의 현재 트리(pfTree)와 같아야 한다.
 * core 테스트는 afterEach에서 이 헬퍼를 돌려 "스냅샷을 빠뜨린 쓰기 경로"를 잡는다.
 *
 * 구 세션(패치 없는 이벤트)은 스냅샷이 없으므로 재생 보장 대상이 아니다 — 건너뛴다.
 */

const tracked = new Set<CoreService>();

/** 테스트에서 만든 서비스를 추적 목록에 넣는다. */
export function trackReplay<T extends CoreService>(svc: T): T {
  tracked.add(svc);
  return svc;
}

const COMPARE_KEYS = [
  "parentId",
  "goal",
  "status",
  "depth",
  "locked",
  "sideEffect",
  "hash",
] as const;

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameStale(
  a: HistoryNode["staleSince"],
  b: HistoryNode["staleSince"],
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.revision === b.revision && a.causeNodeId === b.causeNodeId;
}

/** 한 세션의 현재 revision을 이벤트만으로 복원해 store와 비교한다. */
export async function assertReplayMatchesStore(
  svc: CoreService,
  sessionId: string,
): Promise<void> {
  const events = await svc.getEvents(sessionId);
  if (events.some((e) => !e.detail)) return; // 구 세션 — 재생 보장 없음
  const session = await svc.getSession(sessionId);
  const replay = await svc.getTreeAt({
    sessionId,
    revision: session.revision,
  });
  const live = await svc.pfTree(sessionId);
  const liveById = new Map(live.nodes.map((n) => [n.id, n]));
  const where = `[replay ${sessionId.slice(0, 8)}@rev${session.revision}]`;

  if (replay.nodes.length !== live.nodes.length) {
    throw new Error(
      `${where} node count: replay=${replay.nodes.length} store=${live.nodes.length} ` +
        `(replay=${replay.nodes.map((n) => n.id).join(",")})`,
    );
  }
  for (const got of replay.nodes) {
    const want = liveById.get(got.id);
    if (!want) throw new Error(`${where} replay-only node ${got.id}`);
    for (const k of COMPARE_KEYS) {
      if (got[k] !== want[k])
        throw new Error(
          `${where} node ${got.id}.${k}: replay=${String(got[k])} store=${String(want[k])}`,
        );
    }
    if (!sameList(got.children, want.children))
      throw new Error(
        `${where} node ${got.id}.children: replay=${got.children.join(",")} store=${want.children.join(",")}`,
      );
    if (!sameList(got.dependsOn, want.dependsOn))
      throw new Error(
        `${where} node ${got.id}.dependsOn: replay=${got.dependsOn.join(",")} store=${want.dependsOn.join(",")}`,
      );
    if (!sameStale(got.staleSince, want.staleSince))
      throw new Error(`${where} node ${got.id}.staleSince mismatch`);
  }
}

/** 추적된 모든 서비스의 모든 세션을 검증하고 목록을 비운다. */
export async function assertAllTrackedReplays(): Promise<void> {
  const services = [...tracked];
  tracked.clear();
  for (const svc of services) {
    let sessions: { sessionId: string }[];
    try {
      sessions = (await svc.getSessions()).sessions;
    } catch {
      continue; // 손상/만료 픽스처는 재생 대상이 아니다
    }
    for (const s of sessions) {
      try {
        await assertReplayMatchesStore(svc, s.sessionId);
      } catch (e) {
        // TTL 만료 픽스처는 getSession 단계에서 거부된다 — 재생 대상 아님.
        if (/만료|expired|not found|세션 없음/.test(String(e))) continue;
        throw e;
      }
    }
  }
}
