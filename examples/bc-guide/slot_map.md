# 슬롯 매핑표 — SAP ERP 소개 양식 (21슬라이드) → 다른 BC 소개자료

- template: `template.pptx` (사본, `bc/` 폴더)
- topic: `${params.topic}` (예: BW, Portal, EAI, ABAP 중 하나)
- 분석원: `analysis.json` (python-pptx 추출)

| # | 양식 타이틀 | 레이아웃/구성 | 고정 (유지) | 교체 슬롯 → 새 BC 값 |
|---|------------|--------------|------------|---------------------|
| 1 | SAP ERP 소개 / Day 1 | 빈화면, 타이틀 2개 | 전체 배치·폰트·하단 일자 위치 | TITLE → `${params.topic} 소개 / Day 1`; SUB → 날짜/발표자 (var) |
| 2 | SAP ERP 소개 목차 | 제목+내용, 그림1 | 목차 박스 위치·개수(8줄) | 항목 8개 → `${params.topic}` 장별 목차로 교체 |
| 3 | ERP / SAP 이란 무엇인가 | 제목+내용, 그림2 | 정의 2단 박스 구조 | 용어정의 → `${params.topic}` 정의·약자·범위로 교체 |
| 4 | ERP로 자원관리? | 제목+내용, 그림2 | 질문 박스 4개 구조 | 예시(수만명/수백일/통화) → `${params.topic}` 규모 예시로 교체 |
| 5 | ERP 기반 업무 | 제목+내용, 그림2, 텍스트4 | 3자(공급자/고객/현업) 다이어그램 | 라벨 3개 → `${params.topic}` 이해관계자로 교체 |
| 6 | ERP 기반 업무 - 구성도 | 제목+내용, 그림3 | Legacy×3+EAI 중앙집중 배치 | 시스템명 → `${params.topic}` 구성요소로 교체 (EAI→해당 미들웨어 등) |
| 7 | SAP ERP R/3 | 제목+내용, 텍스트9, 그림2 | 3-Layer 박스 (Pres/App/DB) | 설명문 → `${params.topic}` 3계층 설명으로 교체 |
| 8 | SAP Presentation layer | 제목+내용, 그림4 | 3분할 스크린샷 틀 | 캡처 3~4개 → `${params.topic}` UI 캡처로 교체 |
| 9 | SAP App-Server layer - component | 제목+내용, 그림2 | 질문 4개 말풍선 배치 | 질문(ABAP?/JAVA?/…) → `${params.topic}` 질문 4개로 교체 |
| 10 | SAP App-Server layer – component | 제목+내용, 그림1 | 5줄 불릿 (Process/Dispatcher/WP/Memory) | 불릿 → `${params.topic}` 컴포넌트 5줄로 교체 |
| 11 | 기타 – Request 수행 흐름 | 제목+내용, 그림2 | 8단계 세로 플로우 | 단계문구 → `${params.topic}` 요청 흐름 8단계로 교체 |
| 12 | 기타 – ECC, ERP, S/4HANA… | 제목+내용, 그림1 | 용어 나열 4줄 구조 | 용어줄 → `${params.topic}` 버전/용어 4줄로 교체 |
| 13 | 모듈 업무, 프로그램 | 섹션 표지, 그림3 | 섹션 표지 디자인 | 카피 → `${params.topic} 모듈 업무, 프로그램` (var) |
| 14 | 모듈 업무 – 프로세스의 이해 | 제목+내용, 그림2 | 마스터데이터 정의 블록+예시 박스 | 정의·`PA30` 예시 → `${params.topic}` 대표 T-code/예시로 교체 |
| 15 | 모듈 업무 – ABAP 개발 | 제목+내용, 그림3 | 좌우 2단 (코드원칙/팁) | 원칙문 → `${params.topic}` 개발원칙으로 교체 |
| 16 | SAP Memory Mangement | 제목+내용, 텍스트18, 그림1 | 메모리맵 대형 다이어그램 | 라벨군(Roll/Extended/WP01-03…) → `${params.topic}` 메모리맵으로 교체 |
| 17 | Memory Management– User context | 제목+내용, 그림4 | 세션 4박스+정의 6줄 | 정의 6줄 → `${params.topic}` 세션 개념으로 교체 |
| 18 | CTS, TMS REQUEST | 제목+내용, 그림2 | 3단계 landscape 그림 | 단계명 → `${params.topic}` 이송경로 3단계로 교체 |
| 19 | CTS, TMS REQUEST | 제목+내용, 그림3 | Object 생성→SE09 흐름 | `SE09` → `${params.topic}` 이송 T-code로 교체 |
| 20 | 노츠, 업데이트 | 제목+내용, 그림3 | 하단 URL 바 | URL → `${params.topic}` 지원 링크로 교체 (형식 유지) |
| 21 | 노츠, 업데이트 | 제목+내용, 그림4 | GUI 캡처 2 + 요청문구 | 캡처·`BC에 요청` 문구 → `${params.topic}` 기준·요청처로 교체 |

## 고정 vs 교체 규칙
- 고정: 마스터·16:9·폰트·색·박스 위치·개수·화살표/다이어그램 뼈대.
- 교체: 타이틀·정의문·라벨·캡처·T-code·URL·발표자/일자 (모두 `${params.topic}` 종속).
- 그림 교체 시 크기·자릿수 유지 (틀 안에 맞춤).
