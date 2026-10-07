/**
 * FR-02: the skill the judge selects at `skill_routing` takes effect in the running session.
 *
 * These two tests exist because they fail when that effect breaks:
 *  - the approved selection must reach the executor as an aside through the session's real
 *    message channel, carrying the owner's own statement of what the skill commits to, and be
 *    recorded in session state (drop the delivery and only a returned recommendation is left);
 *  - nothing but an `approve` may deliver or record anything (inject on every verdict and an
 *    abstained or revised selection starts driving the work).
 */
import { describe, expect, test } from "bun:test";
import type { JevTemplateConfig } from "../src/config.js";
import { createJevController } from "../src/controller.js";
import { isRecord } from "../src/guards.js";
import type { DecisionResult, Evidence } from "../src/types.js";

// ---------- a minimal host stand-in (the same shape the other suites use) ----------

type Handler = (event: unknown, ctx?: unknown) => unknown;

interface FakePiHarness {
	pi: {
		on(event: string, handler: Handler): void;
		registerTool(tool: { [key: string]: unknown }): void;
		appendEntry(customType: string, data?: unknown): void;
		sendMessage(payload: unknown, options?: unknown): void;
	};
	sentMessages: Array<{ payload: unknown; options?: unknown }>;
}

function makeFakePi(): FakePiHarness {
	const handlers = new Map<string, Handler[]>();
	const sentMessages: Array<{ payload: unknown; options?: unknown }> = [];
	return {
		pi: {
			on(event, handler) {
				const list = handlers.get(event);
				if (list === undefined) handlers.set(event, [handler]);
				else list.push(handler);
			},
			registerTool() {},
			appendEntry() {},
			sendMessage(payload, options) {
				sentMessages.push({ payload, options });
			},
		},
		sentMessages,
	};
}

const ROUTING: JevTemplateConfig = {
	routing: {
		skills: [
			{ id: "harden-plan", label: "harden-plan", meaning: "harden a plan with a curated checklist" },
			{ id: "systematic-debugging", label: "systematic-debugging", meaning: "diagnose before fixing" },
		],
	},
};

const TASK_QUOTE: Evidence = {
	kind: "user",
	source: "task prompt",
	quote: "Refactor the export pipeline without breaking the JSON export",
};

function skillSubmission() {
	return {
		stage: "skill_routing",
		task: "Refactor the export pipeline",
		proposal: "Pick the skill this task needs from the candidates the owner configured.",
		options: [
			{ id: "harden-plan", label: "harden-plan", meaning: "harden a plan" },
			{ id: "systematic-debugging", label: "systematic-debugging", meaning: "diagnose first" },
		],
		evidence: [TASK_QUOTE],
	};
}

function skillContent(harness: FakePiHarness): string[] {
	return harness.sentMessages
		.map(m => (isRecord(m.payload) ? m.payload["content"] : undefined))
		.filter((c): c is string => typeof c === "string");
}

describe("FR-02: an approved skill takes effect in the running session", () => {
	test("the approved skill is delivered to the session and recorded in state", async () => {
		const harness = makeFakePi();
		const controller = createJevController({
			judge: async (): Promise<DecisionResult> => ({
				verdict: "approve",
				selectedOption: "harden-plan",
				reasons: ["the task is a plan-heavy refactor"],
				confidence: 0.95,
			}),
			template: ROUTING,
		});
		controller.register(harness.pi);

		const out = await controller.submitDecision(skillSubmission());

		expect(out.verdict).toBe("approve");
		expect(out.selectedOption).toBe("harden-plan");
		expect(controller.getState().routedSkill).toBe("harden-plan");
		const delivered = skillContent(harness);
		expect(delivered.length).toBe(1);
		expect(delivered[0]).toContain("harden-plan");
		// the owner's own statement of what choosing the skill commits to travels with it,
		// not the judge's reasons and not a paraphrase
		expect(delivered[0]).toContain("harden a plan with a curated checklist");
		expect(isRecord(harness.sentMessages[0]?.options) ? harness.sentMessages[0]?.options : undefined).toEqual({
			deliverAs: "aside",
			triggerTurn: false,
		});
	});

	test("a selection the judge did not approve is neither delivered nor recorded", async () => {
		const harness = makeFakePi();
		const controller = createJevController({
			judge: async (): Promise<DecisionResult> => ({
				verdict: "insufficient_evidence",
				reasons: ["low_confidence"],
				confidence: 0.4,
			}),
			template: ROUTING,
		});
		controller.register(harness.pi);

		const out = await controller.submitDecision(skillSubmission());

		expect(out.verdict).toBe("insufficient_evidence");
		expect(controller.getState().routedSkill).toBeUndefined();
		expect(skillContent(harness)).toEqual([]);
	});
});
