import { useEffect, useRef } from "react";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, type Diagnostic } from "@codemirror/lint";

// M7-5-3: CodeMirror 6.
// - nonce 는 HTML 의 <meta name="csp-nonce"> 에서 읽는다 (전역/인라인 스크립트로 넘기지 않는다).
// - basicSetup 을 쓰지 않는다 — 필요한 것만 조립해 번들을 작게 유지한다.
// - 검증은 **두 개뿐**: 문법(jsonParseLinter) + 서버 previewEdit 가 돌려준 오류.
//   스키마 검증을 UI 에 다시 구현하지 않는다(R3 / ui4-f "검증 두 벌").

export interface ServerError {
  /** previewEdit 응답의 오류 위치(0 기반 줄). 없으면 문서 전체 오류. */
  from?: number;
  to?: number;
  message: string;
}

/** <meta name="csp-nonce"> 값. 없으면 undefined */
export function readCspNonce(doc: Document = document): string | undefined {
  const m = doc.querySelector('meta[name="csp-nonce"]');
  const v = m?.getAttribute("content");
  return v && v.length > 0 ? v : undefined;
}

/**
 * 서버가 준 오류를 **절대 위치**로 옮긴다 (CM6 Diagnostic 는 줄 객체가 아니라 문서 오프셋을 받는다).
 * lintSource 는 비동기여야 한다 — 문법 진단 뒤에 덧붙이는 구조다.
 */
function serverErrorsExtension(errors: ServerError[]): Extension {
  if (errors.length === 0) return [];
  return linter((view) => {
    const diags: Diagnostic[] = errors.map((e) => {
      const lineNo = Math.min(Math.max(1, (e.from ?? 0) + 1), view.state.doc.lines);
      const toLineNo = Math.min(
        Math.max(lineNo, (e.to ?? e.from ?? 0) + 1),
        view.state.doc.lines,
      );
      return {
        from: view.state.doc.line(lineNo).from,
        to: view.state.doc.line(toLineNo).to,
        severity: "error" as const,
        message: e.message,
      };
    });
    return Promise.resolve(diags);
  }, { delay: 0 });
}

export function JsonEditor({
  value,
  onChange,
  readOnly = false,
  serverErrors = [],
  ariaLabel,
  language = "json",
}: {
  value: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  serverErrors?: ServerError[];
  ariaLabel?: string;
  /** "text" 는 스크립트 보기용 — JSON 언어·검증을 붙이지 않는다(파이썬 등에 오진단 금지) */
  language?: "json" | "text";
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const errCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const nonceRef = useRef<string | undefined>(undefined);
  onChangeRef.current = onChange;
  if (nonceRef.current === undefined) nonceRef.current = readCspNonce();

  useEffect(() => {
    if (!host.current) return;
    const jsonExtras: Extension[] =
      language === "json"
        ? [
            json(),
            // 검증 1/2 — 문법만. 스키마 검증은 서버 몫이다(여기서 두 벌 만들지 않는다).
            linter(jsonParseLinter()),
            // 검증 2/2 — 서버 previewEdit 응답을 위치에 매핑
            errCompartment.current.of(serverErrorsExtension(serverErrors)),
          ]
        : [];
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      ...jsonExtras,
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
      }),
      ...(ariaLabel ? [EditorView.contentAttributes.of({ "aria-label": ariaLabel })] : []),
    ];
    const nonce = nonceRef.current;
    if (nonce) extensions.push(EditorView.cspNonce.of(nonce));
    const v = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host.current,
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, language]);

  // 서버 오류만 갱신 — Compartment 를 쓰면 편집 상태(커서·선택)가 유지된다
  useEffect(() => {
    view.current?.dispatch({
      effects: errCompartment.current.reconfigure(serverErrorsExtension(serverErrors)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverErrors]);

  // 외부 값 변경 반영 (초안 로드/불충돌 복구)
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur === value) return;
    v.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
  }, [value]);

  return <div ref={host} className="cm-host" data-testid="cm-editor" />;
}

/** 스크립트 **보기 전용** — EditorState.readOnly + editable(false) 둘 다 */
export function ReadOnlyCode({
  text,
  ariaLabel,
}: {
  text: string;
  ariaLabel?: string;
}) {
  return (
    <JsonEditor
      value={text}
      readOnly
      language="text"
      ariaLabel={ariaLabel ?? "스크립트(읽기 전용)"}
    />
  );
}