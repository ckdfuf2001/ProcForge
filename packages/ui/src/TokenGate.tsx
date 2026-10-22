import { useState, type FormEvent } from "react";
import { parseTokenInput, type AuthNotice } from "./auth.js";

// M8-ui4: 토큰 입력 화면. 비밀번호 입력 + 자동완성 금지.
// 전체 URL(#t=...)을 붙여넣어도 된다.
export function TokenGate(props: {
  notice: AuthNotice;
  busy: boolean;
  error: string | null;
  onSubmit: (token: string) => void;
}) {
  const [value, setValue] = useState("");
  const [local, setLocal] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const token = parseTokenInput(value);
    if (!token) {
      setLocal("토큰 또는 #t= 가 포함된 전체 URL을 붙여넣어 주세요.");
      return;
    }
    setLocal(null);
    props.onSubmit(token);
  };

  return (
    <main className="app-shell auth-shell">
      <h1>ProcForge</h1>
      <section className="panel token-panel" aria-labelledby="token-title">
        <h2 id="token-title">토큰 입력</h2>
        {props.notice === "restarted" && (
          <p className="alert alert-warn" role="alert">
            서버가 재시작되어 토큰이 바뀌었습니다. 터미널에 출력된 새 URL로 다시 열거나
            새 토큰을 입력해 주세요.
          </p>
        )}
        {props.notice === "unauthorized" && (
          <p className="alert alert-warn" role="alert">
            토큰이 올바르지 않습니다. 터미널에 출력된 URL의 #t= 값을 확인해 주세요.
          </p>
        )}
        {props.notice === "none" && (
          <p className="muted">
            터미널에 출력된 토큰(또는 전체 URL)을 붙여넣어 주세요.
          </p>
        )}
        <form onSubmit={submit} className="token-form">
          <label htmlFor="pf-token">토큰 또는 URL</label>
          <input
            id="pf-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setLocal(null);
            }}
            placeholder="토큰 또는 http://127.0.0.1:PORT/#t=..."
            autoFocus
          />
          <button className="btn btn-primary" type="submit" disabled={props.busy}>
            {props.busy ? "확인 중…" : "연결"}
          </button>
        </form>
        {local && (
          <p className="alert alert-warn" role="alert">
            {local}
          </p>
        )}
        {props.error && (
          <p className="alert alert-warn" role="alert">
            {props.error}
          </p>
        )}
        <p className="muted token-note">
          토큰은 이 탭의 sessionStorage에만 보관하며 쿠키는 쓰지 않습니다. 주소창의
          #t= 값은 저장 직후 지웁니다.
        </p>
      </section>
    </main>
  );
}
