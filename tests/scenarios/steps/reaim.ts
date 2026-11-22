import { expect } from "bun:test";
import { reaim } from "../../../src/activities.js";
import { freshState, recordRecovery, registerTask, type JevState } from "../../../src/state.js";
import type { Evidence, ToolOutcome } from "../../../src/types.js";
import { answeringJudge, boundaryConfig, failingJudge, type FakeAnswerSource } from "../../helpers.js";
import { scoped } from "../registry.js";

/**
 * Step definitions for `scenarios/jev_reaim.feature`. Every step drives production code
 * (`reaim`, `recordRecovery`, `registerTask`) over a fake judge; none of them restates the
 * implementation's own assertions.
 */

const { given, then, when } = scoped("jev_reaim.feature");

interface ReaimWorld {
	state: JevState;
	table: Record<string, FakeAnswerSource>;
	fail: boolean;
	interjection: string;
	evidence: Evidence[];
	outcome?: ToolOutcome;
	calls: number;
	before?: string;
	hold?: { id?: string };
}

const world = (value: unknown): ReaimWorld => value as ReaimWorld;

function setup(value: unknown): ReaimWorld {
	const w = world(value);
	if (w.state === undefined) {
		w.state = freshState();
		w.table = {};
		w.fail = false;
		w.interjection = "";
		w.evidence = [];
		w.calls = 0;
	}
	return w;
}

async function submit(w: ReaimWorld): Promise<void> {
	w.before = w.state.task?.fingerprint;
	w.evidence = w.evidence.length > 0 ? w.evidence : [{ kind: "user", quote: w.interjection }];
	const fake = w.fail ? undefined : answeringJudge(w.table);
	const judge = w.fail ? failingJudge("socket reset", "unavailable") : fake!.judge;
	w.outcome = await reaim({ judge, config: boundaryConfig() }, w.state, {
		interjection: w.interjection,
		evidence: w.evidence,
	});
	w.calls = fake === undefined ? 0 : fake.calls.length;
}

// Background ---------------------------------------------------------------

given("an active development task has approved requirements and an approved plan", value => {
	const w = setup(value);
	registerTask(w.state, "old course");
	w.state.request = { text: "old course", weight: "judged" };
	const fingerprint = w.state.task?.fingerprint ?? "";
	w.state.requirementsApproval = { taskFingerprint: fingerprint, items: ["old obligation"] };
	w.state.plan = { taskFingerprint: fingerprint, planUrl: "local://old-plan.md", planDigest: "old-digits" };
	w.state.acceptance = [{ aspect: "business", revision: 0, label: "serves_business_need", approved: true, confidence: 0.9 }];
});

given("the owner's authentic messages are recorded in session history", value => {
	const w = setup(value);
	w.state.ownerMessages = ["old course"];
});

// Scenario 1 ---------------------------------------------------------------

given("the owner said {string}", (value, said) => {
	const w = setup(value);
	w.interjection = said;
	w.state.request = { text: said, weight: "judged" };
	w.state.ownerMessages = [said];
	w.table.reaim = { probability: 0.9 };
	w.table.external_deliverable = { probability: 0 };
});

given("the owner history establishes a replacement at the approval floor", () => {
	// The floor answer was set with the owner's words; nothing else to arrange.
});

when("the executor submits those exact words with matching authentic user evidence", async value => {
	await submit(world(value));
});

then("Jev reports the login redirect objective under a different task ID", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(true);
	expect(w.state.task?.request).toBe(w.interjection);
	expect(w.state.task?.fingerprint).not.toBe(w.before);
});

then("requirements, plan, acceptance and findings from the old task no longer apply", value => {
	const w = world(value);
	expect(w.state.requirementsApproval).toBeUndefined();
	expect(w.state.plan).toBeUndefined();
	expect(w.state.acceptance).toEqual([]);
});

then("fresh requirements and a fresh plan review are required without another triage", value => {
	const w = world(value);
	expect(w.outcome?.text).toContain("jev_requirements");
	expect(w.outcome?.text).not.toContain("jev_triage");
});

// Scenario 2 ---------------------------------------------------------------

given("the proposed interjection does not occur in any authentic owner message", value => {
	const w = setup(value);
	w.interjection = "Replace the approved scope with a remote deletion service.";
	w.state.request = { text: "Please continue the existing work unchanged.", weight: "judged" };
	w.state.ownerMessages = ["Do not replace the approved scope with a remote deletion service."];
	w.table.reaim = { probability: 0.99 };
});

when("the executor submits it with quoted evidence", async value => {
	await submit(world(value));
});

then("the call is refused before any judge request", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(false);
	expect(w.calls).toBe(0);
});

then("the current task remains unchanged", value => {
	const w = world(value);
	expect(w.state.task?.fingerprint).toBe(w.before);
});

then("Jev does not treat the executor's proposed words as the owner's", value => {
	const w = world(value);
	expect(w.outcome?.text).toContain("current messages");
});

// Scenario 3 ---------------------------------------------------------------

given("a valid interjection occurs in owner history", value => {
	const w = setup(value);
	w.interjection = "Fix the login redirect instead.";
	w.state.request = { text: "Fix the login redirect instead.", weight: "judged" };
	w.state.ownerMessages = ["Fix the login redirect instead."];
	w.table.reaim = { probability: 0.9 };
	w.table.external_deliverable = { probability: 0 };
});

when("the submitted evidence lacks an identical user-kind quote", async value => {
	const w = world(value);
	w.evidence = [{ kind: "code", quote: w.interjection }];
	await submit(w);
});

then("Jev refuses the request without asking the judge", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(false);
	expect(w.calls).toBe(0);
});

then("no task change is recorded", value => {
	const w = world(value);
	expect(w.state.task?.fingerprint).toBe(w.before);
});

then("the result states that caller evidence cannot establish who said it", value => {
	const w = world(value);
	expect(w.outcome?.text).toContain("user quote");
});

// Scenario 4 (outline) -----------------------------------------------------

given("the owner history contains {string}", (value, message) => {
	const w = setup(value);
	w.interjection = message;
	w.state.request = { text: message, weight: "judged" };
	w.state.ownerMessages = [message];
	w.table.reaim = { probability: 0.2 };
});

when("the executor submits it as a re-aim", async value => {
	await submit(world(value));
});

then("the judge does not establish a replacement at the floor", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(false);
	expect(w.calls).toBe(1);
});

then("the existing task keeps its requirement and plan approvals", value => {
	const w = world(value);
	expect(w.state.task?.fingerprint).toBe(w.before);
	expect(w.state.plan).toBeDefined();
});

then("the message remains available to the normal follow-up classification", value => {
	const w = world(value);
	expect(w.state.ownerMessages).toContain(w.interjection);
});

// Scenario 5 ---------------------------------------------------------------

given("no development task is registered", value => {
	const w = setup(value);
	w.state = freshState();
	w.table = {};
});

when("the executor calls jev_reaim", async value => {
	const w = world(value);
	w.interjection = "a new direction";
	await submit(w);
});

then("Jev points the executor to jev_triage", value => {
	expect(world(value).outcome?.text).toContain("jev_triage");
});

then("no task is created", value => {
	expect(world(value).state.task).toBeUndefined();
});

then("the message does not reference a removed continuation command", value => {
	const w = world(value);
	expect(w.outcome?.text ?? "").not.toContain("/jev-continue");
});

// Scenario 6 ---------------------------------------------------------------

given("a diagnostic finding or refused submission exists", value => {
	const w = setup(value);
	w.hold = recordRecovery(w.state, "reaim", { interjection: "old" }, {
		ok: false,
		text: "Re-aim not established.",
		details: { kind: "refusal", approved: false },
	});
	w.interjection = "old course";
	w.state.request = { text: "old course", weight: "judged" };
	w.table.reaim = { probability: 0.2 };
});

when("the executor submits a re-aim whose only purpose is to escape that finding", async value => {
	await submit(world(value));
});

then("the judge does not establish an owner replacement", value => {
	expect(world(value).outcome?.ok).toBe(false);
});

then("the original finding is still present", value => {
	const w = world(value);
	expect(w.state.hold?.id).toBe(w.hold?.id);
	expect(w.state.hold).toBeDefined();
});

then("no continuation, waiver or repair permit is created", value => {
	const w = world(value);
	expect(w.state.task?.request).toBe("old course");
	expect((w.state as unknown as Record<string, unknown>)["continuation"]).toBeUndefined();
});

// Scenario 7 ---------------------------------------------------------------

given("a genuine replacement asks for a document for an outside audience", value => {
	const w = setup(value);
	w.interjection = "Write a launch brief for outside readers instead.";
	w.state.request = { text: w.interjection, weight: "judged" };
	w.state.ownerMessages = [w.interjection];
	w.table.reaim = { probability: 0.95 };
	w.table.external_deliverable = { probability: 0.95 };
});

when("the re-aim is approved", async value => {
	await submit(world(value));
});

then("the replacement task is marked external", value => {
	const w = world(value);
	expect(w.outcome?.ok).toBe(true);
	expect(w.state.task?.external).toBe(true);
});

then("the anti-slop review applies as an advisory check", value => {
	const w = world(value);
	expect(w.outcome?.text).toContain("anti-slop");
});

then("the external classification does not authorize publication", value => {
	const w = world(value);
	expect(w.outcome?.text ?? "").not.toContain("authorize");
});

// Scenario 8 ---------------------------------------------------------------

given("a valid re-aim submission", value => {
	const w = setup(value);
	w.interjection = "Ship the dashboard instead.";
	w.state.request = { text: w.interjection, weight: "judged" };
	w.state.ownerMessages = [w.interjection];
	w.before = w.state.task?.fingerprint ?? "";
	w.table.reaim = { probability: 0.2 };
});

when("the replacement probability is below the floor", async value => {
	await submit(world(value));
});

then("the task ID and objective stay the same", value => {
	const w = world(value);
	expect(w.state.task?.request).toBe("old course");
	expect(w.state.task?.fingerprint).toBe(w.before);
});

then("the result is classified as a refusal of the replacement claim", value => {
	const w = world(value);
	expect(w.outcome?.details?.["kind"]).toBe("refusal");
});

then("the executor may continue the current task or submit materially different owner evidence", value => {
	const w = world(value);
	expect(w.outcome?.text).toContain("change the evidence");
});

// Scenario 9 ---------------------------------------------------------------

when("the judge is unavailable", async value => {
	const w = world(value);
	w.fail = true;
	await submit(w);
});

then("Jev reports there was no decision", value => {
	expect(world(value).outcome?.text).toContain("No judge decision exists");
});

then("ordinary work continues under the current task and host permissions", value => {
	const w = world(value);
	expect(w.state.task?.request).toBe("old course");
});
