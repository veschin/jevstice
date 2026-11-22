/**
 * Step definitions for `scenarios/jev_session_mode.feature`. The owner command, the per-session
 * disabled set and the strict-supervisor branch are exercised through the real controller over the
 * fake host seams; the harness, judge table and plan helpers come from `diagnostics.ts`.
 */
import { expect } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ControllerRuntime } from "../../../src/controller.js";
import { isConsequentialMutation } from "../../../src/gates.js";
import { freshState } from "../../../src/state.js";
import { asRecord } from "../../../src/types.js";
import {
	answeringJudge,
	blockReason,
	fakeArtifacts,
	fakeCtx,
	stopDecision,
	stopEvent,
	toolCallEvent,
	toolDetails,
	toolFailed,
	toolResultEvent,
	toolText,
	until,
} from "../../helpers.js";
import { scoped } from "../registry.js";
import {
	approvePlan,
	consultParams,
	counts,
	createJevWorld,
	gate,
	lastMessage,
	lastSend,
	observe,
	reviewParams,
	setup,
} from "./diagnostics.js";

const { given, when, then } = scoped("jev_session_mode.feature");

function segment(pattern: RegExp, text: string): string {
	return pattern.exec(text)?.[1] ?? "";
}

// ---------------------------------------------------------------------------
// @jev_session_mode_01
// ---------------------------------------------------------------------------

given("Jev diagnostics are on for this session", value => {
	const world = setup(value);
	world.pi.callCommand("jev", "", world.ctx);
	expect(lastMessage(world, "jev.mode")).toContain("Jev diagnostics are on");
});

when("the owner runs /jev with no argument", value => {
	const world = setup(value);
	world.pi.callCommand("jev", "", world.ctx);
});

then("the report says that diagnostics are on", value => {
	expect(lastMessage(setup(value), "jev.mode")).toContain("Jev diagnostics are on");
});

then("it states that work never requires a Jev continuation permission", value => {
	expect(lastMessage(setup(value), "jev.mode")).toContain("Work never requires a Jev continuation permission");
});

then("no model turn is started by the report", value => {
	const world = setup(value);
	const send = lastSend(world, "jev.mode");
	expect(send).toBeDefined();
	expect(send?.options?.triggerTurn).not.toBe(true);
	expect(world.fake.calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// @jev_session_mode_02
// ---------------------------------------------------------------------------

given("Jev diagnostics are on", value => {
	const world = setup(value);
	world.pi.callCommand("jev", "", world.ctx);
	expect(lastMessage(world, "jev.mode")).toContain("Jev diagnostics are on");
});

when("the owner runs /jev off", value => {
	const world = setup(value);
	world.pi.callCommand("jev", "off", world.ctx);
	expect(lastMessage(world, "jev.mode")).toContain("Jev diagnostics are off");
});

then("Jev stops judging tool activity, source capture and workflow prompt injection for that session", async value => {
	const world = setup(value);
	const calls = world.fake.calls.length;
	const judged = await world.pi.callTool("jev_consult", consultParams(), world.ctx);
	expect(toolDetails(judged)["enabled"]).toBe(false);
	expect(world.fake.calls.length).toBe(calls);
	await world.pi.emit(
		"tool_result",
		toolResultEvent("write", { path: "src/a.ts", content: "export const a = 1;" }, "Wrote src/a.ts"),
		world.ctx,
	);
	expect(world.fake.calls.length).toBe(calls);
	const prepared = await world.pi.emit("before_agent_start", { prompt: "Continue the work", systemPrompt: ["Host policy"] }, world.ctx);
	expect(asRecord(Array.isArray(prepared) ? prepared[0] : prepared)?.["systemPrompt"]).toEqual(["Host policy"]);
});

then("a consequential project action is not refused for a missing Jev decision", async value => {
	const world = setup(value);
	expect(
		blockReason(await world.pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "export const a = 2;" }), world.ctx)),
	).toBeUndefined();
});

then("ending the session is not held for Jev", async value => {
	const world = setup(value);
	expect(stopDecision(await world.pi.emit("session_stop", stopEvent(), world.ctx))).toBeUndefined();
});

// ---------------------------------------------------------------------------
// @jev_session_mode_03
// ---------------------------------------------------------------------------

given("the owner has turned Jev diagnostics off for this session", value => {
	const world = setup(value);
	world.pi.callCommand("jev", "off", world.ctx);
	expect(lastMessage(world, "jev.mode")).toContain("Jev diagnostics are off");
});

when("the executor calls any Jev tool", async value => {
	const world = setup(value);
	world.results["consult"] = await world.pi.callTool("jev_consult", consultParams(), world.ctx);
	world.results["triage"] = await world.pi.callTool("jev_triage", { request: "Report the coverage" }, world.ctx);
});

then("the result states that Jevstice is off and no judgment ran", value => {
	const world = setup(value);
	for (const result of [world.results["consult"], world.results["triage"]]) {
		expect(toolText(result)).toContain("Jevstice is off");
		expect(toolText(result)).toContain("No judgment ran");
	}
});

then("the result is marked disabled and skipped", value => {
	const world = setup(value);
	for (const result of [world.results["consult"], world.results["triage"]]) {
		expect(toolDetails(result)["enabled"]).toBe(false);
		expect(toolDetails(result)["skipped"]).toBe(true);
	}
});

then("no approval, acceptance or finding is recorded", async value => {
	const world = setup(value);
	expect(world.fake.calls).toHaveLength(0);
	for (const result of [world.results["consult"], world.results["triage"]]) {
		expect(toolDetails(result)["approved"]).not.toBe(true);
		expect(toolDetails(result)["acceptance"]).toBeUndefined();
	}
	// Restore the checks to read the retained state: the off-mode calls left no decision behind.
	world.pi.callCommand("jev", "on", world.ctx);
	const details = await observe(world);
	expect(details["findings"]).toEqual([]);
	expect(details["hold"]).toBeUndefined();
	expect(details["acceptance"]).toEqual([]);
});

// ---------------------------------------------------------------------------
// @jev_session_mode_04
// ---------------------------------------------------------------------------

given("the owner has turned diagnostics off after earlier approvals and findings", async value => {
	const world = setup(value);
	await approvePlan(world);
	world.table["review"] = { label: "defect", confidence: 0.95 };
	const review = await world.pi.callTool("jev_review", reviewParams(), world.ctx);
	expect(toolDetails(review)["approved"]).toBe(false);
	const details = await observe(world);
	expect(details["acceptance"]).toEqual([]);
	world.pi.callCommand("jev-status", "", world.ctx);
	expect(await until(() => lastMessage(world, "jev.status").length > 0)).toBe(true);
	world.info["status"] = lastMessage(world, "jev.status");
	world.info["checks"] = { ...counts(details, "checks") };
	world.info["work"] = { ...counts(details, "work") };
	world.pi.callCommand("jev", "off", world.ctx);
	expect(lastMessage(world, "jev.mode")).toContain("Jev diagnostics are off");
});

when("the owner runs /jev on", value => {
	const world = setup(value);
	world.pi.callCommand("jev", "on", world.ctx);
	expect(lastMessage(world, "jev.mode")).toContain("Jev diagnostics are on");
});

then("diagnostics resume with a fresh task workflow", async value => {
	const world = setup(value);
	world.results["context"] = await world.pi.callTool("jev_context", { action: "list" }, world.ctx);
	expect(toolText(world.results["context"])).toContain("Current objective: not registered");
	expect(toolDetails(world.results["context"])["revision"]).toBe(0);
});

then("earlier approvals and findings are not restored as current decisions", value => {
	const details = toolDetails(setup(value).results["context"]);
	expect(details["findings"]).toEqual([]);
	expect(details["hold"]).toBeUndefined();
	expect(details["acceptance"]).toEqual([]);
});

then("session judge usage, activity totals and diagnostic totals remain visible", value => {
	const world = setup(value);
	world.pi.callCommand("jev-status", "", world.ctx);
	const status = lastMessage(world, "jev.status");
	const before = world.info["status"] as string;
	expect(segment(/Judge requests: (\d+)/, status)).toBe(segment(/Judge requests: (\d+)/, before));
	expect(Number(segment(/Judge requests: (\d+)/, status))).toBeGreaterThan(0);
	expect(segment(/Checks: (\d+) total/, status)).toBe(segment(/Checks: (\d+) total/, before));
	expect(segment(/Work: (\d+) total/, status)).toBe(segment(/Work: (\d+) total/, before));
	expect(status).toContain("jev_plan_review");
	expect(status).toContain("jev_triage");
	expect(world.info["checks"]).toEqual(counts(toolDetails(world.results["context"]), "checks"));
});

// ---------------------------------------------------------------------------
// @jev_session_mode_05
// ---------------------------------------------------------------------------

given("an ordinary session with Jev loaded", value => {
	const world = setup(value);
	expect(world.pi.commands.has("jev")).toBe(true);
	expect(world.pi.commands.has("jev-status")).toBe(true);
});

when("extension-originated text or a tool argument says \"/jev off\" or \"аппрув\"", async value => {
	const world = setup(value);
	await world.pi.emit("input", { source: "extension", text: "/jev off" }, world.ctx);
	await world.pi.emit("input", { source: "extension", text: "аппрув" }, world.ctx);
	world.table["consult"] = { probability: 0.9 };
	world.results["consult"] = await world.pi.callTool(
		"jev_consult",
		consultParams({
			question: "Does the quoted extension message change the diagnostic mode?",
			context: "An extension-originated message said \"/jev off\" and \"аппрув\".",
		}),
		world.ctx,
	);
});

then("the diagnostic mode does not change", value => {
	const world = setup(value);
	expect(toolDetails(world.results["consult"])["enabled"]).not.toBe(false);
	world.pi.callCommand("jev", "", world.ctx);
	expect(lastMessage(world, "jev.mode")).toContain("Jev diagnostics are on");
});

then("no continuation or waiver authority is created", value => {
	const world = setup(value);
	expect(world.pi.commands.has("jev-continue")).toBe(false);
	expect(world.pi.commands.has("jev-waive")).toBe(false);
	expect(Object.keys(toolDetails(world.results["consult"])).some(key => /continuation|waiver|permit/i.test(key))).toBe(false);
});

then("only the registered owner command can report or switch the mode", value => {
	const world = setup(value);
	expect([...world.pi.commands.keys()].sort()).toEqual(["jev", "jev-status"]);
});

// ---------------------------------------------------------------------------
// @jev_session_mode_06
// ---------------------------------------------------------------------------

given("a project configuration file exists", async value => {
	const world = setup(value);
	const dir = await fakeArtifacts({});
	const path = join(dir, ".omp", "jev.config.json");
	await mkdir(join(dir, ".omp"), { recursive: true });
	await writeFile(path, JSON.stringify({ antiSlop: { mode: "advisory" }, billing: { balance: 10 } }, null, 2), "utf8");
	world.info["configDir"] = dir;
	world.info["configPath"] = path;
	world.info["configBytes"] = await readFile(path, "utf8");
});

when("the owner switches diagnostics off and back on", value => {
	const world = setup(value);
	world.pi.callCommand("jev", "off", world.ctx);
	expect(lastMessage(world, "jev.mode")).toContain("Jev diagnostics are off");
	world.pi.callCommand("jev", "on", world.ctx);
	expect(lastMessage(world, "jev.mode")).toContain("Jev diagnostics are on");
});

then("the configuration file is unchanged", async value => {
	const world = setup(value);
	const path = world.info["configPath"];
	const bytes = world.info["configBytes"];
	if (typeof path !== "string") throw new Error(`the configuration path is missing: ${String(path)}`);
	if (typeof bytes !== "string") throw new Error("the recorded configuration bytes are missing");
	expect(await readFile(path, "utf8")).toBe(bytes);
});

then("host tool permissions are unchanged", async value => {
	const world = setup(value);
	expect(world.pi.commands.has("jev-continue")).toBe(false);
	expect(world.pi.commands.has("jev-waive")).toBe(false);
	expect(
		blockReason(await world.pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "export const a = 1;" }), world.ctx)),
	).toBeUndefined();
});

then("the next loaded session starts with diagnostics on", async value => {
	const world = setup(value);
	await world.pi.emit("session_shutdown", {}, world.ctx);
	await world.pi.emit("session_start", {}, world.ctx);
	world.table["consult"] = { probability: 0.9 };
	const result = await world.pi.callTool("jev_consult", consultParams(), world.ctx);
	expect(toolDetails(result)["enabled"]).not.toBe(false);
	expect(toolFailed(result)).toBe(false);
	await rm(world.info["configDir"] as string, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// @jev_session_mode_07
// ---------------------------------------------------------------------------

given("two sessions share the same project and configuration", value => {
	const world = setup(value);
	const second = fakeCtx({ sessionId: "session-2" }) as Record<string, unknown>;
	(second["ui"] as Record<string, unknown>)["notify"] = () => {};
	world.secondCtx = second;
});

given("the owner turns diagnostics off in the first session", value => {
	const world = setup(value);
	world.pi.callCommand("jev", "off", world.ctx);
	expect(lastMessage(world, "jev.mode")).toContain("Jev diagnostics are off");
});

when("both sessions continue working", async value => {
	const world = setup(value);
	world.table["consult"] = { probability: 0.9 };
	world.results["first"] = await world.pi.callTool("jev_consult", consultParams(), world.ctx);
	world.results["second"] = await world.pi.callTool("jev_consult", consultParams(), world.secondCtx!);
});

then("only the first session has checks off", value => {
	const world = setup(value);
	expect(toolDetails(world.results["first"])["enabled"]).toBe(false);
	expect(toolDetails(world.results["second"])["enabled"]).not.toBe(false);
});

then("the second session continues its own diagnostic behavior", value => {
	const world = setup(value);
	const second = toolDetails(world.results["second"]);
	expect(asRecord(second["diagnostics"])).toBeDefined();
	expect(counts(second, "checks")["passed"]).toBe(1);
});

then("no approval crosses from one session to the other", value => {
	const world = setup(value);
	expect(toolDetails(world.results["second"])["approved"]).not.toBe(true);
	expect(toolDetails(world.results["first"])["approved"]).not.toBe(true);
});

// ---------------------------------------------------------------------------
// @jev_session_mode_08
// ---------------------------------------------------------------------------

given("a judge request is in flight for an earlier mode", async value => {
	const world = setup(value);
	world.table["consult"] = { probability: 0.9 };
	world.gate = gate();
	world.info["pending"] = world.pi.callTool("jev_consult", consultParams(), world.ctx);
	await world.gate.opened;
});

when("the owner turns diagnostics off", value => {
	const world = setup(value);
	world.pi.callCommand("jev", "off", world.ctx);
	expect(lastMessage(world, "jev.mode")).toContain("Jev diagnostics are off");
});

then("the in-flight answer is not recorded as a current diagnostic", async value => {
	const world = setup(value);
	world.gate?.release();
	const result = await (world.info["pending"] as Promise<unknown>);
	world.results["pending"] = result;
	expect(toolDetails(result)["enabled"]).toBe(false);
	expect(toolFailed(result)).toBe(false);
	world.pi.callCommand("jev", "on", world.ctx);
	const details = await observe(world);
	expect(counts(details, "checks")["passed"]).toBe(0);
	expect(details["findings"]).toEqual([]);
});

then("it does not approve or block work in the new mode", async value => {
	const world = setup(value);
	expect(toolDetails(world.results["pending"])["approved"]).not.toBe(true);
	expect(toolDetails(world.results["pending"])["kind"]).not.toBe("passed");
	expect(
		blockReason(await world.pi.emit("tool_call", toolCallEvent("write", { path: "src/a.ts", content: "export const a = 1;" }), world.ctx)),
	).toBeUndefined();
	expect(stopDecision(await world.pi.emit("session_stop", stopEvent(), world.ctx))).toBeUndefined();
});

// ---------------------------------------------------------------------------
// @jev_session_mode_09
// ---------------------------------------------------------------------------

given("the owner runs /jev with an unsupported argument", value => {
	const world = setup(value);
	world.pi.callCommand("jev", "later", world.ctx);
	expect(world.notices.at(-1) ?? "").toContain("/jev");
});

when("the command is handled", () => {
	// The handler ran in the previous step; the notice carries its answer.
});

then("the mode is unchanged", async value => {
	const world = setup(value);
	world.table["consult"] = { probability: 0.9 };
	const result = await world.pi.callTool("jev_consult", consultParams(), world.ctx);
	expect(toolDetails(result)["enabled"]).not.toBe(false);
	expect(toolFailed(result)).toBe(false);
});

then("the owner sees that /jev, /jev on and /jev off are the accepted forms", value => {
	const world = setup(value);
	const notice = world.notices.join("\n");
	expect(notice).toContain("/jev on");
	expect(notice).toContain("/jev off");
});

// ---------------------------------------------------------------------------
// @jev_session_mode_10
// ---------------------------------------------------------------------------

given("the executor is working in the session", value => {
	const world = setup(value);
	world.ctx["isIdle"] = () => false;
});

when("the owner turns diagnostics on or off", value => {
	const world = setup(value);
	world.pi.callCommand("jev", "off", world.ctx);
	expect(lastMessage(world, "jev.mode")).toContain("Jev diagnostics are off");
});

then("the mode message is queued for the next turn without steering the active batch", value => {
	const world = setup(value);
	const send = lastSend(world, "jev.mode");
	expect(send).toBeDefined();
	expect(send?.options?.deliverAs).toBe("nextTurn");
	expect(send?.options?.triggerTurn).not.toBe(true);
});

then("the queued message carries only mode guidance, not a permission change", value => {
	const world = setup(value);
	const content = lastMessage(world, "jev.mode");
	expect(content).toContain("changes checks only");
	expect(content).toContain("not host permissions or supervisor safety limits");
});

then("an idle session does not start a model turn merely to announce the mode", value => {
	const world = setup(value);
	const idle = fakeCtx({ sessionId: "idle-session" }) as Record<string, unknown>;
	(idle["ui"] as Record<string, unknown>)["notify"] = () => {};
	world.pi.callCommand("jev", "on", idle);
	const send = lastSend(world, "jev.mode");
	expect(send?.options?.deliverAs).toBe("nextTurn");
	expect(send?.options?.triggerTurn).not.toBe(true);
});

// ---------------------------------------------------------------------------
// @jev_session_mode_11
// ---------------------------------------------------------------------------

given("a strict supervised run is active", async value => {
	const target = value as Record<string, unknown>;
	const state = freshState();
	state.autonomous = true;
	const judge = answeringJudge({ consult: { probability: 0.5 } }).judge;
	const log: string[] = [];
	const runtime: ControllerRuntime = {
		stateFor: () => state,
		judgeFor: () => judge,
		readArtifact: async () => null,
		consequential: (tool, input) => isConsequentialMutation(tool, input),
		beforeTool: () => {
			log.push("beforeTool");
			return undefined;
		},
		admit: async () => {
			log.push("admit");
		},
		checkpoint: async () => {
			log.push("checkpoint");
		},
		toolResult: async () => {
			log.push("toolResult");
		},
		stop: async () => {
			log.push("stop");
			return undefined;
		},
	};
	const world = createJevWorld({ autonomy: runtime }, target);
	world.strict = { state: state as unknown as Record<string, unknown>, log };
	// Durable diagnostic evidence recorded before the owner switches the checks off.
	const recorded = await world.pi.callTool("jev_consult", consultParams(), world.ctx);
	expect(toolDetails(recorded)["kind"]).toBe("unclear");
	expect((state.findings ?? []).length).toBe(1);
});

then("strict roots, effect permissions, resource limits and containment remain in force", async value => {
	const world = setup(value);
	const log = world.strict!.log;
	const before = log.length;
	const results = await world.pi.emit(
		"tool_call",
		toolCallEvent("write", { path: "src/a.ts", content: "export const a = 1;" }),
		world.ctx,
	);
	expect(blockReason(results)).toBeUndefined();
	expect(log.length).toBeGreaterThan(before);
	expect(log).toContain("beforeTool");
	expect(log).toContain("admit");
});

then("the run's durable safety records are not discarded", value => {
	const world = setup(value);
	const state = world.strict!.state;
	expect(state["autonomous"]).toBe(true);
	const findings = state["findings"] as Array<Record<string, unknown>>;
	expect(findings).toHaveLength(1);
	const diagnostics = state["diagnostics"] as { checks: Record<string, number> };
	expect(diagnostics.checks["inconclusive"]).toBe(1);
});

then("Jev verdicts remain diagnostic evidence in that run", async value => {
	const world = setup(value);
	const state = world.strict!.state;
	const findings = state["findings"] as Array<Record<string, unknown>>;
	expect(asRecord(findings[0]?.["result"])?.["kind"]).toBe("unclear");
	expect(state["acceptance"]).toEqual([]);
	const offResult = await world.pi.callTool("jev_consult", consultParams(), world.ctx);
	expect(toolDetails(offResult)["enabled"]).toBe(false);
	expect(toolDetails(offResult)["approved"]).not.toBe(true);
	expect((state["findings"] as unknown[]).length).toBe(1);
});

// ---------------------------------------------------------------------------
// @jev_session_mode_12
// ---------------------------------------------------------------------------

given("the owner switches diagnostics off or on", async value => {
	const world = setup(value);
	world.table["consult"] = { probability: 0.9 };
	const judged = await world.pi.callTool("jev_consult", consultParams(), world.ctx);
	expect(toolDetails(judged)["enabled"]).not.toBe(false);
	world.pi.callCommand("jev", "off", world.ctx);
	expect(lastMessage(world, "jev.mode")).toContain("Jev diagnostics are off");
});

when("the owner runs /jev-status", value => {
	const world = setup(value);
	world.pi.callCommand("jev-status", "", world.ctx);
});

then("the report names the session mode", value => {
	expect(lastMessage(setup(value), "jev.status")).toContain("Session mode: off");
});

then("it shows the last recorded diagnostic coverage without presenting it as approval", value => {
	const status = lastMessage(setup(value), "jev.status");
	expect(status).toContain("Checks:");
	expect(status).toContain("not execution permission");
	expect(status).toMatch(/1 passed/);
});

then("it does not resume checks while the mode is off", async value => {
	const world = setup(value);
	const calls = world.fake.calls.length;
	world.table["consult"] = { probability: 0.5 };
	const result = await world.pi.callTool(
		"jev_consult",
		consultParams({ question: "Is the recorded report current?", context: "The report was recorded after the mode switch." }),
		world.ctx,
	);
	expect(toolDetails(result)["enabled"]).toBe(false);
	expect(world.fake.calls.length).toBe(calls);
	// The status report is equally available with the checks on, still as diagnostics only.
	world.pi.callCommand("jev", "on", world.ctx);
	world.pi.callCommand("jev-status", "", world.ctx);
	const status = lastMessage(world, "jev.status");
	expect(status).toContain("Session mode: on");
	expect(status).toContain("Checks:");
	expect(status).toMatch(/1 passed/);
	expect(world.fake.calls.length).toBe(calls);
});
