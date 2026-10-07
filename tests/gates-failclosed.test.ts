/**
 * The shared normalizer and the restore validator are the two places a malformed answer could turn
 * into an approval. Both were found open by the 2026-10-08 independent review: `NaN` satisfied
 * `confidence < 0 || confidence > 1` as false, so an approve verdict with a non-finite confidence
 * kept approving, and the restore path carried any number into the displayed record.
 */
import { describe, expect, test } from "bun:test";
import { normalizeJudgeResult, restoreGateRecordFields } from "../src/gates.js";

const OPTIONS = [
	{ id: "approve", label: "Approve", meaning: "accept" },
	{ id: "revise", label: "Revise", meaning: "rework" },
];

describe("gate normalizer: a non-finite confidence never approves", () => {
	test("NaN confidence with an offered approve option is demoted to insufficient_evidence", () => {
		const result = normalizeJudgeResult(
			{ verdict: "approve", selectedOption: "approve", confidence: Number.NaN, reasons: ["approved"] },
			OPTIONS,
			0.8,
		);
		expect(result.verdict).toBe("insufficient_evidence");
	});

	test("Infinity is rejected the same way", () => {
		const result = normalizeJudgeResult(
			{ verdict: "approve", selectedOption: "approve", confidence: Number.POSITIVE_INFINITY },
			OPTIONS,
			0.8,
		);
		expect(result.verdict).toBe("insufficient_evidence");
	});

	test("a well-formed approving answer still approves", () => {
		const result = normalizeJudgeResult(
			{ verdict: "approve", selectedOption: "approve", confidence: 0.93 },
			OPTIONS,
			0.8,
		);
		expect(result.verdict).toBe("approve");
	});
});

describe("gate record restore: a confidence from disk is checked before it is trusted", () => {
	test("a non-finite or out-of-range confidence is dropped, a sound one survives", () => {
		const base = { judged: true, blocked: false, at: 1791409608780 };
		expect(restoreGateRecordFields({ ...base, confidence: Number.NaN })?.confidence).toBeUndefined();
		expect(restoreGateRecordFields({ ...base, confidence: 1.4 })?.confidence).toBeUndefined();
		expect(restoreGateRecordFields({ ...base, confidence: 0.42 })?.confidence).toBe(0.42);
	});
});
