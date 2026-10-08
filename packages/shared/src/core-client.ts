import type { Constraint, Node, Session, ArgSpec, SideEffect } from "./schema.js";

// local → core 호출은 반드시 이 인터페이스를 통해서만 한다. (가이드 §3, §8)
// M0~M5: packages/core가 이 인터페이스의 in-process 구현을 제공한다.
// M6: HTTP CoreClient 구현으로 교체한다. local 소스에서 core 직접 import 금지.

export type PfStartInput = {
  request: string;
  params?: Record<string, string>;
  toolCatalog: Session["toolCatalog"];
  limits?: Session["limits"];
};

export type PfStartOutput = {
  session: Session;
  node: Node;
  instruction: string;
};

export type PfNextOutput =
  | { done: false; node: Node; instruction: string }
  | { done: true };

export type PfReportInput = {
  sessionId: string;
  nodeId: string;
  tool: { server: string; name: string };
  args: Record<string, unknown>;
  resultSummary: string;
  resultJson?: unknown;
  artifacts?: string[];
  artifactContents?: Record<string, string>;
};

export type PfReportOutput = {
  verdict: "pass" | "fail" | "unverifiable";
  failedConstraints: string[];
  unverified?: string[];
  instruction: string;
};

export type PfResolveDecision = "leaf" | "split" | "retry" | "ask_human";

export type PfResolveInput = {
  sessionId: string;
  nodeId: string;
  decision: PfResolveDecision;
  children?: { goal: string; dependsOn?: string[]; sideEffect?: SideEffect }[];
  argSpecs?: Record<string, ArgSpec>;
  sideEffect?: SideEffect;
  tool?: { server: string; name: string };
};

export type PfResolveOutput = {
  node: Node;
  created?: Node[];
  instruction: string;
};

export type PfAdviseOutput = {
  constraints: Constraint[];
  node: Node;
};

export interface CoreClient {
  pfStart(input: PfStartInput): Promise<PfStartOutput>;
  pfNext(sessionId: string): Promise<PfNextOutput>;
  pfReport(input: PfReportInput): Promise<PfReportOutput>;
  pfResolve(input: PfResolveInput): Promise<PfResolveOutput>;
  pfAdvise(sessionId: string, nodeId: string, text: string): Promise<PfAdviseOutput>;
  pfTree(sessionId: string): Promise<{ nodes: Node[]; session: Session }>;
  pfLock(sessionId: string, nodeId: string): Promise<Node>;
  pfReopen(sessionId: string, nodeId: string, reason: string): Promise<Node>;
}
