# monthly

원본 세션: c6a0407a-31bf-4988-996a-92f32555659f / 생성: 2026-10-11T04:57:03.494Z

## 파라미터

- `month` (필수, --param 지정)

## 목차

1. 월간보고서 (`1`)
2. 월별 xlsx를 집계한다 (`1.1`)
3. 보고서 pptx를 생성한다 (`1.2`)

## 단계

### 1. 월별 xlsx를 집계한다 (`1.1`)

- 도구: `host/script`
- 인자:
  - `xlsx` ← sales-${params.month}.xlsx
  - `agg` = 스크립트: `scripts/1_1.py`
- 확인 조건:
  - [equals] path=period
  - [file_exists] path=sales-${params.month}.xlsx
  - [json_path_exists] path=rows
  - [json_path_exists] path=total
  - [json_path_exists] path=period
- 기대 출력: `agg 2026-09 total 2000000`

### 2. 보고서 pptx를 생성한다 (`1.2`)

- 도구: `host/script`
- 선행: `1.1`
- 인자:
  - `template` = `"shell.pptx"`
  - `output` = `"output/rendered.pptx"`
  - `cover` ← 월간보고서 ${params.month} (최종)
  - `tableTitle` ← ${params.month} 실적 요약
  - `rows` ← $1.1.rows
  - `slide` = `1`
  - `render` = 스크립트: `scripts/1_2.py`
- 확인 조건:
  - [numeric_match] expected=$1.1.total
  - [file_exists] path=shell.pptx
  - [file_exists] path=output/rendered.pptx
  - [json_path_exists] path=total
  - [json_path_exists] path=title
- 기대 출력: `render 2026-09 total 2000000`

## 고정값 감사 (M5.1-B1)

- 발견 없음. 고정 인자·제약에 params 값·날짜 표현·녹화 수치 하드코딩이 없다.
