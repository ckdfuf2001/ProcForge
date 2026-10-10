# 제작 절차서 — `${params.topic}` 소개자료 만들기 (SAP ERP 양식 재사용)

## 0. 준비물
- `bc/template.pptx` (원본 사본, 직접 수정 금지)
- `bc/analysis.json`, `bc/slot_map.md`, `bc/replace_guide.md`
- 새 주제 `${params.topic}`의 정의·그림·T-code·URL 모음

## 1. 사본 생성
- `template.pptx` → `bc/output_${params.topic}.pptx`로 복사.
- 원본은 보관, 작업은 사본에서만.

## 2. 표지/목차 (S1–S2)
- S1 TITLE → `${params.topic} 소개 / Day 1`, SUB → 일자/발표자.
- S2 목차 8줄 → `${params.topic}` 장별 목차로 교체.

## 3. 개념 (S3–S4)
- 정의 2단 박스 → `${params.topic}` 정의로 교체, 질문박스 2개 교체.

## 4. 업무/구성도 (S5–S6)
- 라벨·시스템명만 교체, 다이어그램 뼈대 유지.

## 5. 아키텍처 (S7–S12)
- 3-Layer·UI캡처·질문4·불릿5·8단계·용어4 순서대로 교체.
- 그림은 틀 크기 유지하며 `${params.topic}` 캡처로 교체.

## 6. 모듈/개발 (S13–S17)
- 섹션표지 → `${params.topic} 모듈 업무, 프로그램`.
- T-code·메모리맵 라벨 교체 (박스 수 유지).

## 7. 이송/노츠 (S18–S21)
- 3단계·T-code·URL·요청처 교체.

## 8. 검수
- `SAP/ERP` 잔여 검색, 박스 수 대조(analysis.json), 맞춤법·정렬 확인.
- `plan.md` 체크리스트 통과 후 배포.
