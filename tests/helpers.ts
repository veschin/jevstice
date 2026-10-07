import type { DecisionRequest, DecisionResult, Judge } from "../src/types";
import { POLICY } from "../src/types";

/** Deterministic mock judge for integration tests: maps chosen option id to verdict. */
export function makeMockJudge(
  respond: (req: DecisionRequest) => DecisionResult,
): Judge & { calls: DecisionRequest[] } {
  const calls: DecisionRequest[] = [];
  const judge: Judge = async req => {
    calls.push(req);
    return respond(req);
  };
  return Object.assign(judge, { calls });
}

export function approveOption(id: string, confidence = 0.99): (req: DecisionRequest) => DecisionResult {
  return req => {
    if (!req.options.some(o => o.id === id)) throw new Error(`option ${id} not offered`);
    return { verdict: "approve", selectedOption: id, reasons: ["approved_with_confidence"], confidence };
  };
}

export function lowConfidenceApprove(id: string): DecisionResult {
  return {
    verdict: "insufficient_evidence",
    reasons: ["low_confidence"],
    confidence: POLICY.minConfidenceToApprove - 0.1,
  };
}

export const sampleRequest: DecisionRequest = {
  stage: "completion_review",
  task: "Verify the executor finished the assigned slice",
  proposal: "Executor reports all tests pass",
  options: [
    { id: "approve", label: "Approve completion", meaning: "accept result" },
    { id: "revise", label: "Send back with reasons", meaning: "rework bounded by policy" },
  ],
  evidence: [
    { kind: "execution", source: "bun test", quote: "42 pass, 0 fail" },
  ],
};
