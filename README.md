# ProcForge

[![ci](https://github.com/ckdfuf2001/ProcForge/actions/workflows/ci.yml/badge.svg)](https://github.com/ckdfuf2001/ProcForge/actions/workflows/ci.yml)

자연어 요청을 재귀 분해해 "AI 코딩툴의 툴 호출로 이루어진 절차서 + 단위 테스트 묶음"을 만드는 MCP.

- `packages/local` — 로컬 MCP 서버 (공개 가능)
- `packages/core` — 분해·검증 정책 서버 로직 (비공개 예정, M6 분리)
- `packages/shared` — zod 스키마·계약 타입

개발 기준: `docs/DECISIONS.md`, 마일스톤별 완료 조건은 테스트로 증명.
수동 검증: `docs/M2-manual.md`, 실사용 기록: `docs/M3.5-dogfood.md`.
