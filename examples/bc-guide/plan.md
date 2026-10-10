# SAP ERP 소개 양식으로 다른 BC 소개자료를 만드는 방법 — 최종 계획서

- session: `6d79df41-9b9e-427c-a156-c8080cb5c42b` (ProcForge, 4/4 leaf 확정)
- template: `bc/template.pptx` (원본 `chat_uploads/1.신입소개자료-SAP_ERP소개.pptx`의 작업 사본, 21슬라이드)
- topic: `${params.topic}` (기본값 `미정`. 예: BW / Portal / EAI / HR)
- 관련 파일: `bc/analysis.json`, `bc/slot_map.md`, `bc/replace_guide.md`, `bc/procedure.md`
- 원본 스펙: 16:9 (13.33×7.5in), 마스터 1, 레이아웃 12, 표 0, 그림 위주+텍스트박스

## 1. 양식 구조 분석 (노드 1.1, leaf)
- S1 표지(빈화면, 텍스트2) / S2 목차(8줄 불릿+그림1) / S3–S4 개념정의(그림2씩)
- S5–S6 업무/구성도(3자·Legacy×3+EAI) / S7–S12 아키텍처(3-Layer, UI4장, 질문4, 불릿5, 8단계, 용어4)
- S13 섹션표지 / S14–S17 모듈·ABAP·메모리맵(텍스트18 대형) ·세션 / S18–S19 CTS/TMS / S20–S21 노츠·지원
- 상세: `analysis.json` (슬라이드별 layout·shapes·全文)

## 2. 슬롯 매핑표 (노드 1.2, leaf) — 핵심
- 원칙: 배치는 고정, 내용은 교체. 그림 교체 시 틀 크기 유지.

| # | 양식 타이틀 | 고정 (유지) | 교체 슬롯 → `${params.topic}` 값 |
|---|------------|------------|----------------------------------|
| 1 | SAP ERP 소개 / Day 1 | 배치·폰트·일자 위치 | TITLE → `${params.topic} 소개 / Day 1`; SUB → 일자/발표자 |
| 2 | SAP ERP 소개 목차 | 목차박스 8줄 | 8항목 → `${params.topic}` 장별 목차 |
| 3 | ERP / SAP 이란 무엇인가 | 2단 정의박스 | 용어정의 → `${params.topic}` 정의·약자·범위 |
| 4 | ERP로 자원관리? | 질문박스 4개 | 예시 → `${params.topic}` 규모 예시 |
| 5 | ERP 기반 업무 | 3자 다이어그램 | 라벨 → `${params.topic}` 이해관계자 |
| 6 | ERP 기반 업무 - 구성도 | Legacy×3+EAI 배치 | 시스템명 → `${params.topic}` 구성요소 |
| 7 | SAP ERP R/3 | 3-Layer 박스 | 설명 → `${params.topic}` 3계층 설명 |
| 8 | SAP Presentation layer | 3분할 틀 | 캡처 4개 → `${params.topic}` UI 캡처 |
| 9 | SAP App-Server layer - component | 질문 4 말풍선 | 질문 → `${params.topic}` 질문 4개 |
| 10 | SAP App-Server layer – component | 불릿 5줄 | 불릿 → `${params.topic}` 컴포넌트 5줄 |
| 11 | 기타 – Request 수행 흐름 | 8단계 플로우 | 단계 → `${params.topic}` 요청흐름 8단계 |
| 12 | 기타 – ECC, ERP, S/4HANA… | 용어 4줄 | 용어 → `${params.topic}` 버전/용어 4줄 |
| 13 | 모듈 업무, 프로그램 | 섹션표지 | 카피 → `${params.topic} 모듈 업무, 프로그램` |
| 14 | 모듈 업무 – 프로세스의 이해 | 정의+예시박스 | `PA30` → `${params.topic}` 대표 T-code |
| 15 | 모듈 업무 – ABAP 개발 | 좌우 2단 | 원칙 → `${params.topic}` 개발원칙 |
| 16 | SAP Memory Mangement | 대형 메모리맵 | 라벨군 → `${params.topic}` 메모리맵 |
| 17 | Memory Management– User context | 세션 4박스+6줄 | 정의 → `${params.topic}` 세션개념 |
| 18 | CTS, TMS REQUEST | 3단계 그림 | 단계 → `${params.topic}` 이송경로 |
| 19 | CTS, TMS REQUEST | SE09 흐름 | `SE09` → `${params.topic}` 이송 T-code |
| 20 | 노츠, 업데이트 | URL 바 | URL → `${params.topic}` 지원링크 |
| 21 | 노츠, 업데이트 | 캡처2+요청문구 | 캡처·요청처 → `${params.topic}` 기준·요청처 |

## 3. 주제별 교체 요소 (노드 1.3, leaf)
- 문구: 표지·목차8·정의·질문·규모·3-Layer7줄·불릿5·8단계·용어4·T-code(`PA30`/`SE09`)·URL(`support.sap.com`)·`BC에 요청` → 모두 `${params.topic}` 종속 (var).
- 그림: S2 1장 … S21 4장, 위치·크기 고정, 내용만 `${params.topic}` 캡처로 교체.
- 표: 없음. 텍스트박스 수 유지 (S16 18개·S7 9개 등 박스당 1문장 교체).
- 금지: 마스터·16:9·폰트·색·좌표·21장 순서.
- 검수: `SAP/ERP` 잔여검색, 박스수 대조, T-code/URL 동작확인.

## 4. 제작 절차 (노드 1.4, leaf, var=`${params.topic}`)
1. `template.pptx` → `output_${params.topic}.pptx` 복사 (원본 보존).
2. S1–S2 표지/목차 교체 → 3. S3–S4 개념 → 4. S5–S6 업무/구성도 → 5. S7–S12 아키텍처 → 6. S13–S17 모듈/개발 → 7. S18–S21 이송/노츠.
3. 검수 후 배포. 새 주제는 `topic`만 바꿔 반복 (재바인딩 가능).

## 5. ProcForge 확정 기록
- 1.1 양식구조분석: `opencode/bash` fixed (`python …/dump.py`) — pass→leaf (rev5).
- 1.2 슬롯매핑표: `opencode/bash` fixed (verify 21-row) — pass→leaf (rev8).
- 1.3 교체요소정리: `opencode/bash` fixed (verify 29 lines) — pass→leaf (rev11).
- 1.4 제작절차서: `opencode/bash` **var** (`ref ${params.topic}`) — pass→leaf (rev14).
- `pf_next` done=true 확인. `pf_finalize`는 수행하지 않음 (본 plan.md가 최종 산출물).
