#!/usr/bin/env node
// M10-0 실측 스크립트 (사용자 PC에서 1회 실행).
// 사용: node scripts/m10-probe.mjs --model <provider/model> [--url http://127.0.0.1:4096] [--password <pw>] [--concurrency 2|4] [--only remember|remember-off|toolsask]
// 전제: `opencode serve`가 떠 있어야 한다. 이 스크립트는 serve를 띄우지 않는다.
// 안전: 임시 세션만 만들고 끝나면 삭제한다. 비용 상한 안내를 먼저 출력한다.

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(name);
  return i === -1 ? def : (args[i + 1] ?? def);
}
const BASE = (opt("--url", "http://127.0.0.1:4096") ?? "").replace(/\/$/, "");
const MODEL = opt("--model", "");
const PASSWORD = opt("--password", "");
const CONCURRENCY = Number(opt("--concurrency", "0"));
const USER = "opencode";

if (!MODEL || !MODEL.includes("/")) {
  console.error("사용: node scripts/m10-probe.mjs --model <provider/model> [--url ...] [--password ...] [--concurrency 2|4]");
  process.exit(2);
}
const [providerID, ...rest] = MODEL.split("/");
const modelID = rest.join("/");
console.log(`[m10-probe] 모델 ${providerID}/${modelID} — 장문 대화 금지, 짧은 확인 프롬프트만 보낸다.`);
console.log(`[m10-probe] 대상 ${BASE}`);

const authHeader = PASSWORD
  ? { Authorization: "Basic " + Buffer.from(`${USER}:${PASSWORD}`).toString("base64") }
  : {};

const results = [];
function record(item, status, detail) {
  results.push({ item, status, detail });
  console.log(`[${status}] ${item} — ${detail}`);
}

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "content-type": "application/json", ...authHeader, ...(opts.headers ?? {}) },
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // HTML(/doc) 등은 원문 유지
  }
  return { status: r.status, json, text };
}

// SSE를 fetch 스트림으로 읽는다 (EventSource 없이).
function subscribeEvents(onEvent, signal) {
  return fetch(BASE + "/event", { headers: { accept: "text/event-stream", ...authHeader }, signal }).then(
    async (r) => {
      if (!r.ok || !r.body) throw new Error(`SSE 연결 실패: ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let cur = {};
      const flush = () => {
        if (cur.data !== undefined) {
          try {
            const j = JSON.parse(cur.data);
            // 실측: 1.18.18 SSE data는 {id, type, properties} 봉투다.
            if (j && typeof j === "object" && typeof j.type === "string") {
              onEvent(j.type, j.properties ?? j);
            } else {
              onEvent(cur.event ?? "message", j);
            }
          } catch {
            onEvent(cur.event ?? "message", cur.data);
          }
        }
        cur = {};
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          if (line === "") {
            flush();
          } else if (line.startsWith("event:")) {
            cur.event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            cur.data = (cur.data ?? "") + line.slice(5).trim();
          }
        }
      }
    },
  );
}

function waitFor(events, pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setTimeout(() => reject(new Error(`${label} 타임아웃(${timeoutMs}ms)`)), timeoutMs);
    const check = () => events.some(pred);
    if (check()) {
      clearTimeout(timer);
      resolve(events.find(pred));
      return;
    }
    const iv = setInterval(() => {
      if (check()) {
        clearTimeout(timer);
        clearInterval(iv);
        resolve(events.find(pred));
      } else if (Date.now() - t0 > timeoutMs) {
        clearTimeout(timer);
        clearInterval(iv);
        reject(new Error(`${label} 타임아웃(${timeoutMs}ms)`));
      }
    }, 200);
  });
}

const createdSessions = [];
let totalCost = 0;
function noteCost(p) {
  const c = p?.info?.cost;
  if (typeof c === "number") totalCost += c;
}
async function cleanup() {
  for (const id of createdSessions.splice(0)) {
    try {
      await api(`/session/${id}`, { method: "DELETE" });
    } catch {
      // 정리 실패 무시
    }
  }
}

// M11-probe: 단일 실측 모드 (--only remember|remember-off|toolsask). 기본 전체 실행은 그대로.
// remember: 1회차 asked에 {response:"once", remember:true}로 답하고,
//   같은 세션에서 같은 도구를 다시 부를 때 회차별 tool part 수·asked 수를 센다.
// remember-off: 대조군. remember 없이 once로만 답한다. 2회차 asked>=1이면
//   remember 효과를 인정하는 근거가 된다. 2회차 tool part가 0이면 판정 불가.
// toolsask: tools {"*": false}와 세션 ask 설정을 동시에 걸고
//   tool part 수와 asked 수를 센다.
const ONLY = opt("--only", "");

async function runRemember(useRemember) {
  const tag = useRemember ? "remember 재등장" : "remember-off 대조";
  const title = useRemember ? "m11-probe-remember" : "m11-probe-remember-off";
  const events = [];
  const ctl = new AbortController();
  const sub = subscribeEvents((t, p) => { events.push({ t, p, at: Date.now() }); noteCost(p); }, ctl.signal).catch(() => {});
  const countTools = (sid, from, to) => events.filter((e) =>
    e.t === "message.part.updated" && e.p?.part?.type === "tool" &&
    e.p?.part?.sessionID === sid && e.at >= from && (to === undefined || e.at < to)).length;
  const countAsked = (sid, from, to) => events.filter((e) =>
    e.t === "permission.asked" && e.p?.sessionID === sid && e.at >= from && (to === undefined || e.at < to)).length;
  try {
    // 세션 단위로 ask를 건다 (서버 기본값이 allow라도 실측 가능).
    // PermissionRuleset은 배열 [{permission, pattern, action}] 형식 (1.18.x /doc 기준).
    const c = await api("/session", { method: "POST", body: JSON.stringify({ title, permission: [{ permission: "bash", pattern: "*", action: "ask" }] }) });
    const sid = c.json?.id;
    if (!sid) throw new Error(`세션 생성 실패: ${c.status}`);
    createdSessions.push(sid);
    const mark0 = Date.now();
    await api(`/session/${sid}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({
        model: { providerID, modelID },
        parts: [{ type: "text", text: "You MUST call the bash tool with command \"echo probe-remember-1\" right now. Do nothing else first." }],
      }),
    });
    const first = await waitFor(
      events, (e) => e.t === "permission.asked" && e.p?.sessionID === sid, 150000, "permission.asked",
    ).catch(() => null);
    if (!first) {
      record(tag, "실패", "asked 없음 (모델이 bash를 안 쓰거나 서버가 허용)");
      return;
    }
    const answer = { response: "once" };
    if (useRemember) answer.remember = true;
    await api(`/session/${sid}/permissions/${first.p?.id}`, {
      method: "POST",
      body: JSON.stringify(answer),
    });
    await waitFor(events, (e) => e.t === "session.idle" && e.p?.sessionID === sid, 120000, "idle").catch(() => {});
    const mark1 = Date.now();
    const asked1 = countAsked(sid, mark0, mark1);
    const tools1 = countTools(sid, mark0, mark1);
    await api(`/session/${sid}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({
        model: { providerID, modelID },
        parts: [{ type: "text", text: "You MUST call the bash tool with command \"echo probe-remember-2\" right now. Do nothing else first." }],
      }),
    });
    await waitFor(events, (e) => e.t === "session.idle" && e.p?.sessionID === sid, 180000, "idle").catch(() => {});
    const asked2 = countAsked(sid, mark1);
    const tools2 = countTools(sid, mark1);
    if (tools2 === 0) {
      record(tag, "판정 불가", `asked 1회차=${asked1} 2회차=${asked2}, tool 1회차=${tools1} 2회차=0 (모델이 2회차에 bash를 안 씀) — 재시도 없음`);
      return;
    }
    record(tag, "확인", `asked 1회차=${asked1} 2회차=${asked2}, tool 1회차=${tools1} 2회차=${tools2}`);
  } catch (e) {
    record(tag, "실패", String(e && e.message ? e.message : e));
  } finally {
    ctl.abort();
    try {
      await sub;
    } catch {
      // 무시
    }
  }
  await cleanup();
}

async function runToolsAsk() {
  const events = [];
  const ctl = new AbortController();
  const sub = subscribeEvents((t, p) => { events.push({ t, p, at: Date.now() }); noteCost(p); }, ctl.signal).catch(() => {});
  try {
    // 세션 단위로 ask를 건다 (서버 기본값이 allow라도 실측 가능).
    const c = await api("/session", { method: "POST", body: JSON.stringify({ title: "m11-probe-toolsask", permission: [{ permission: "bash", pattern: "*", action: "ask" }] }) });
    const sid = c.json?.id;
    if (!sid) throw new Error(`세션 생성 실패: ${c.status}`);
    createdSessions.push(sid);
    await api(`/session/${sid}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({
        model: { providerID, modelID },
        tools: { "*": false },
        parts: [{ type: "text", text: "You MUST call the bash tool with command \"echo probe-toolsask\" right now. Do nothing else first." }],
      }),
    });
    // idle까지 기다리되, 타임아웃해도 그때까지 온 것으로 판정한다.
    await waitFor(events, (e) => e.t === "session.idle" && e.p?.sessionID === sid, 120000, "idle").catch(() => {});
    const tools = events.filter((e) => e.t === "message.part.updated" && e.p?.part?.type === "tool" && e.p?.part?.sessionID === sid).length;
    const asked = events.filter((e) => e.t === "permission.asked" && e.p?.sessionID === sid).length;
    record("tools:false+ask", "확인", `tool part ${tools}건, asked ${asked}건`);
  } catch (e) {
    record("tools:false+ask", "실패", String(e && e.message ? e.message : e));
  } finally {
    ctl.abort();
    try {
      await sub;
    } catch {
      // 무시
    }
  }
  await cleanup();
}

async function writeReport() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`m10-probe-${stamp}.json`, JSON.stringify({ at: new Date().toISOString(), url: BASE, model: MODEL, totalCostUsd: totalCost, results }, null, 2));
  console.log(`[m10-probe] 저장: m10-probe-${stamp}.json`);
  console.log(`[m10-probe] 총 비용(USD 합산): ${totalCost}`);
}

async function main() {
  if (ONLY === "remember" || ONLY === "remember-off" || ONLY === "toolsask") {
    if (ONLY === "remember") await runRemember(true);
    else if (ONLY === "remember-off") await runRemember(false);
    else await runToolsAsk();
    await writeReport();
    const bad = results.filter((r) => r.status !== "확인").length;
    if (bad > 0) process.exitCode = 1;
    return;
  }
  // 0. 비용 상한 안내
  console.log("[m10-probe] 비용: 짧은 프롬프트 수건. 장문·반복 실행 금지.");

  // 1. /doc 키 대조
  try {
    const d = await api("/doc");
    const keys = ["/session", "prompt_async", "/permissions/", "/mcp", "/config/providers", "session.idle"];
    const missing = keys.filter((k) => !d.text.includes(k));
    record("/doc 키 대조", missing.length === 0 ? "확인" : "불일치", missing.length === 0 ? "6키 전부 존재" : `없음: ${missing.join(",")}`);
  } catch (e) {
    record("/doc 키 대조", "실패", String(e));
  }

  // 2. health + (password 있으면) Basic auth
  try {
    const h = await api("/global/health");
    record("health", h.json && h.json.healthy ? "확인" : "불일치", `version=${h.json?.version ?? "?"}`);
  } catch (e) {
    record("health", "실패", String(e));
  }
  if (PASSWORD) {
    try {
      const r = await fetch(BASE + "/session");
      record("auth 401", r.status === 401 ? "확인" : "불일치", `무인증 상태=${r.status}`);
    } catch (e) {
      record("auth 401", "실패", String(e));
    }
  }

  // 3. 세션 생성 → prompt_async → idle 순서
  const events = [];
  const ctl = new AbortController();
  const sub = subscribeEvents((t, p) => { events.push({ t, p, at: Date.now() }); noteCost(p); }, ctl.signal).catch(() => {});
  let sid = null;
  try {
    const c = await api("/session", { method: "POST", body: JSON.stringify({ title: "m10-probe" }) });
    if (c.status !== 200 || !c.json?.id) throw new Error(`세션 생성 실패: ${c.status}`);
    sid = c.json.id;
    createdSessions.push(sid);
    const order = [];
    const seen = (t) => (e) => {
      if (e.t === t && !order.includes(t)) order.push(t);
      return false;
    };
    void seen;
    const p = await api(`/session/${sid}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({
        model: { providerID, modelID },
        tools: { edit: false, write: false, apply_patch: false, bash: false },
        parts: [{ type: "text", text: "1+1은? 한 단어로 답해라." }],
      }),
    });
    if (p.status !== 204) throw new Error(`prompt_async 상태=${p.status}`);
    const idle = await waitFor(events, (e) => e.t === "session.idle" && e.p?.sessionID === sid, 180000, "session.idle");
    void idle;
    const seq = events.filter((e) => e.p?.sessionID === sid || e.p?.info?.sessionID === sid).map((e) => e.t);
    const uniq = [...new Set(seq)];
    record("prompt_async→idle", "확인", uniq.join(" > "));
    const toolCalls = events.filter((e) => e.t === "message.part.updated" && e.p?.part?.type === "tool").length;
    record("tools 비활성", toolCalls === 0 ? "확인" : "불일치", `도구 호출 part ${toolCalls}건`);
  } catch (e) {
    record("prompt_async→idle", "실패", String(e && e.message ? e.message : e));
  }

  // 4. 권한 왕복 (once/reject/always 순 — always 규칙이 이후 세션에 남기 때문).
  // 실측(1.18.18): 요청 이벤트는 permission.asked (types 문서의 permission.updated 아님).
  for (const resp of ["once", "reject", "always"]) {
    let psid = null;
    try {
      const c = await api("/session", { method: "POST", body: JSON.stringify({ title: `m10-probe-perm-${resp}` }) });
      psid = c.json?.id;
      if (!psid) throw new Error("세션 생성 실패");
      createdSessions.push(psid);
      await api(`/session/${psid}/prompt_async`, {
        method: "POST",
        body: JSON.stringify({
          model: { providerID, modelID },
          parts: [{ type: "text", text: "You MUST call the bash tool with command \"echo probe-ok\" right now. Do nothing else first." }],
        }),
      });
      const perm = await waitFor(
        events,
        (e) => e.t === "permission.asked" && e.p?.sessionID === psid,
        150000,
        "permission.asked",
      ).catch(() => null);
      if (!perm) {
        const attempted = events.some(
          (e) => e.t === "message.part.updated" && e.p?.part?.type === "tool" && e.p?.part?.sessionID === psid,
        );
        record(
          `권한 응답(${resp})`,
          "불일치",
          attempted ? "permission.asked 없음 (서버가 허용함)" : "도구 호출 없음 (모델이 bash를 쓰지 않음)",
        );
        continue;
      }
      const pid = perm.p?.id;
      const r = await api(`/session/${psid}/permissions/${pid}`, {
        method: "POST",
        body: JSON.stringify({ response: resp }),
      });
      // 응답 효과로 판정한다 (실측: 별도 replied 이벤트는 오지 않는다).
      // once/always → 도구 completed, reject → completed 없이 idle.
      try {
        await waitFor(events, (e) => e.t === "session.idle" && e.p?.sessionID === psid, 120000, "idle");
      } catch {
        // idle 없이 끝나도 아래 tool 상태로 판정한다
      }
      const doneTools = events.filter(
        (e) =>
          e.t === "message.part.updated" &&
          e.p?.part?.type === "tool" &&
          e.p?.part?.sessionID === psid &&
          e.p?.part?.state?.status === "completed",
      );
      const denied = resp === "reject" ? doneTools.length === 0 : doneTools.length > 0;
      record(
        `권한 응답(${resp})`,
        r.status === 200 && denied ? "확인" : "불일치",
        `api=${r.status} completed=${doneTools.length}건 permissionId=${pid}`,
      );
    } catch (e) {
      record(`권한 응답(${resp})`, "실패", String(e && e.message ? e.message : e));
    }
  }

  // 5. POST /mcp 반영 시점
  try {
    const before = await api("/mcp");
    const names0 = before.json ? Object.keys(before.json) : [];
    const add = await api("/mcp", {
      method: "POST",
      body: JSON.stringify({ name: "m10-probe-dummy", config: { type: "local", command: ["node", "-e", "1"], enabled: false } }),
    });
    const t0 = Date.now();
    let found = false;
    for (let i = 0; i < 30 && !found; i++) {
      const g = await api("/mcp");
      found = !!g.json && "m10-probe-dummy" in g.json;
      if (!found) await new Promise((r) => setTimeout(r, 1000));
    }
    record("POST /mcp 반영", found ? "확인" : "불일치", `add=${add.status} 반영소요~${((Date.now() - t0) / 1000).toFixed(0)}s (전 ${names0.length}개)`);
  } catch (e) {
    record("POST /mcp 반영", "실패", String(e && e.message ? e.message : e));
  }

  ctl.abort();
  try {
    await sub;
  } catch {
    // 중단 무시
  }
  await cleanup();

  // 6. --concurrency N: N개 동시 세션, 각 time-to-idle 기록
  if (CONCURRENCY === 2 || CONCURRENCY === 4) {
    console.log(`[m10-probe] 동시 세션 ${CONCURRENCY}개 — serve 프로세스 RSS는 별도 기록 필요:`);
    console.log(`[m10-probe] Get-Process -Name opencode,opencode-* | Select-Object Name,WS`);
    const times = await Promise.all(
      Array.from({ length: CONCURRENCY }, async (_, i) => {
        const c = await api("/session", { method: "POST", body: JSON.stringify({ title: `m10-probe-c${i}` }) });
        const id = c.json?.id;
        if (!id) return -1;
        createdSessions.push(id);
        const t0 = Date.now();
        await api(`/session/${id}/prompt_async`, {
          method: "POST",
          body: JSON.stringify({
            model: { providerID, modelID },
            tools: { edit: false, write: false, apply_patch: false, bash: false },
            parts: [{ type: "text", text: "1+1은? 한 단어로 답해라." }],
          }),
        });
        const evs = [];
        const c2 = new AbortController();
        const s2 = subscribeEvents((t, p) => { evs.push({ t, p }); noteCost(p); }, c2.signal).catch(() => {});
        try {
          await waitFor(evs, (e) => e.t === "session.idle" && e.p?.sessionID === id, 180000, "idle");
        } finally {
          c2.abort();
          try {
            await s2;
          } catch {
            // 무시
          }
        }
        return Date.now() - t0;
      }),
    );
    record(`동시 ${CONCURRENCY}개`, "확인", `time-to-idle ms: ${times.join(",")}`);
    await cleanup();
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`m10-probe-${stamp}.json`, JSON.stringify({ at: new Date().toISOString(), url: BASE, model: MODEL, totalCostUsd: totalCost, results }, null, 2));
  console.log(`[m10-probe] 저장: m10-probe-${stamp}.json`);
  console.log(`[m10-probe] 총 비용(USD 합산): ${totalCost}`);
  const bad = results.filter((r) => r.status !== "확인").length;
  if (bad > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[m10-probe] 실패: ${e instanceof Error ? e.message : String(e)}`);
  cleanup().finally(() => {
    process.exitCode = 1;
  });
});
