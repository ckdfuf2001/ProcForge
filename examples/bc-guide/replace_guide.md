# 주제별 교체 요소 정리 — `${params.topic}`용

> 이 파일의 모든 `${params.topic}` 표기는 새 BC 주제로 치환한다.
> 예: `${params.topic}` = BW / Portal / EAI / HR 등.

## 1. 문구 (텍스트 슬롯)
- 표지: `SAP ERP 소개` → `${params.topic} 소개`; `Day 1` 유지; 하단 `2019.02 / ERP팀 …` → 새 일자/팀 (var).
- 목차 8줄: `ERP/SAP…` → `${params.topic}` 장 제목 8개로 전면 교체.
- 정의: `ERP(Enterprise Resource Planning)` / `SAP(Systems…)` → `${params.topic}` 정식명칭·약자·범위.
- 질문박스: `전사란?/자원이란?` → `${params.topic}` 핵심 질문 2개.
- 규모예시: 수만명/수백일/통화 → `${params.topic}` 규모 수치로 교체.
- 3-Layer 설명 7줄, 컴포넌트 5줄, 8단계 흐름, 용어 4줄: 주어만 `SAP`→`${params.topic}`, 술어는 구조 유지.
- 섹션표지: `모듈 업무, 프로그램` → `${params.topic} 모듈 업무, 프로그램`.
- 예시 T-code: `PA30`, `SE09` → `${params.topic}` 대표 T-code (예: BW면 `RSA1`, Portal면 해당 메뉴).
- 하단 URL: `http://support.sap.com` → `${params.topic}` 지원 링크 (형식 유지).
- 요청문구: `component level … BC에 요청` → `${params.topic}` 기준치·요청처로 교체.

## 2. 그림 (이미지 슬롯)
- S2 아키텍처 1장, S3–S4 개념도 2장씩, S5–S6 업무/구성도 2–3장, S7 3-Layer 2장, S8 UI 4장, S9–S12 컴포넌트/흐름 각 1–2장, S15–S17 메모리맵/세션 3–4장, S18–S21 이송/노츠 2–4장.
- 교체 원칙: 위치·크기 고정, 내용만 `${params.topic}` 캡처/다이어그램으로 교체.
- 캡처는 한글 UI 그대로 사용, 테두리·화살표 스타일 유지.

## 3. 표·다이어그램 (구조 슬롯)
- 표 없음 (tables=0 전 슬라이드). 텍스트박스+도형으로 구성.
- 다이어그램 뼈대 고정: 3자 관계도(S5), 중앙집중형(S6), 3-Layer(S7), 8단계 플로우(S11), 메모리맵(S16), 3단계 landscape(S18).
- 텍스트박스 개수 유지 (예: S16 18개, S7 9개) — 박스당 1문장 교체.

## 4. 교체 금지 (고정)
- 마스터·16:9·폰트·색·박스 좌표·화살표·섹션 순서 (21장 순서 유지).
- `Day 1`, 장 번호, `기타 – …` 같은 접두 패턴.

## 5. 검수 체크
- [ ] `${params.topic}` 잔여 `SAP/ERP` 문자열 없음 (제외: 비교표에서 의도적 언급)
- [ ] 그림 1장당 텍스트박스 수 = analysis.json과 동일
- [ ] T-code·URL 동작 확인
