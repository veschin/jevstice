/**
 * Step definitions for `scenarios/jev_autonomy.feature`.
 *
 * These steps drive the real modules: the SQLite store (`openAutonomyStore`), driver argument/policy
 * parsing, status/stop projection, the strict entry's fail-closed registration, the scope capability
 * probe, real `systemd-run --user --scope` containment, a real supervisor launch of the strict entry
 * (`02`) and a bound runtime child inside an observed scope for admission, stale diagnostics,
 * recovery, retry budgets, completion, safe devices, reviewed publication, pending effects and
 * rotation (`06`, `07`, `08`, `10`-`13`, `16`, `17`, `19`, `20`). Every live run is bounded and its
 * scope/child is cleaned up; no scope or containment observation is faked.
 */
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { afterEach, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import strictExtension from "../../../autonomy/index.js";
import ordinaryExtension from "../../../src/index.js";
import { DEFAULT_CONFIG } from "../../../src/config.js";
import type { Judge } from "../../../src/judge.js";
import { recordAction, sha256, type RecoveryHold } from "../../../src/state.js";
import { asRecord } from "../../../src/types.js";
import {
	parseAutonomyPolicy,
	runAutonomyCli,
	startAutonomyRun,
	statusAutonomy,
	stopAutonomy,
	type AutonomySummary,
	type DriverResult,
} from "../../../autonomy/driver.js";
import {
	autonomyBootId,
	autonomyScopeCommand,
	checkAutonomyScopeCapability,
	fenceAutonomyScope,
	makeAutonomyScopeLaunch,
	observeAutonomyScope,
	type AutonomyScope,
	type AutonomyScopeLaunch,
} from "../../../autonomy/scope.js";
import {
	openAutonomyStore,
	processAlive,
	processIdentity,
	type AutonomyIntent,
	type AutonomyPolicy,
	type AutonomyRun,
	type AutonomyStore,
	type ProcessIdentity,
} from "../../../autonomy/store.js";
import {
	blockReason,
	fakeCtx,
	fakePi,
	fakeZod,
	stopDecision,
	stopEvent,
	toolCallEvent,
	type FakePi,
} from "../../helpers.js";
import { scoped } from "../registry.js";

const { given, when, then } = scoped("jev_autonomy.feature");

// ---------------------------------------------------------------------------
// Fixtures: one real private store per scenario, removed after the test.
// ---------------------------------------------------------------------------

interface Fixture {
	dir: string;
	root: string;
	storePath: string;
	store?: AutonomyStore;
}

interface AutonomyWorld {
	fixture?: Fixture;
	pi?: FakePi;
	runId: string;
	firstRunId?: string;
	inheritedStorePath?: string;
	toolResults?: unknown[][];
	limit?: string;
	originalPolicy?: AutonomyPolicy;
	askError?: string;
	intentId?: string;
	bytes?: Uint8Array;
	statusRows?: AutonomySummary[];
	finding?: RecoveryHold;
	capabilityError?: string;
	startError?: string;
	strictCommands?: string[];
	live?: LiveSupervisor;
	liveJudgeCalls?: number;
	stopResult?: DriverResult;
	runtime?: RuntimeHarness;
	recovered?: RuntimeHarness;
	rotation?: {
		runId: string;
		oldChild: ProcessIdentity;
		oldScope: AutonomyScope;
	};
	forkError?: string;
	observed?: { child: ProcessIdentity; scope: AutonomyScope };
	input?: Record<string, unknown>;
	callId?: string;
	judged?: unknown;
	response?: unknown;
	revision?: number;
	judgeCalls?: number;
}

function w(value: unknown): AutonomyWorld {
	if (typeof value !== "object" || value === null) throw new Error("the scenario world is not an object");
	return value as AutonomyWorld;
}

function me() {
	const identity = processIdentity();
	if (identity === null) throw new Error("the test process has no native identity");
	return identity;
}

const liveDirs: string[] = [];
const liveStores: AutonomyStore[] = [];
const envJournal: Array<{ key: string; previous: string | undefined }> = [];

function setTrackedEnv(key: string, value: string): void {
	envJournal.push({ key, previous: process.env[key] });
	process.env[key] = value;
}

function resetTrackedEnv(): void {
	while (envJournal.length > 0) {
		const entry = envJournal.pop();
		if (entry === undefined) continue;
		if (entry.previous === undefined) delete process.env[entry.key];
		else process.env[entry.key] = entry.previous;
	}
}

const liveCleanups: Array<() => Promise<void>> = [];
const runtimeCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of runtimeCleanups.splice(0).reverse()) {
		try {
			await cleanup();
		} catch {
			// A scope that is already gone is not a failed assertion.
		}
	}
	for (const cleanup of liveCleanups.splice(0).reverse()) {
		try {
			await cleanup();
		} catch {
			// The supervisor's own result reports a failed stop; cleanup is best-effort here.
		}
	}
	for (const store of liveStores.splice(0)) {
		try {
			store.close();
		} catch {
			// The test that failed already reports its own problem.
		}
	}
	for (const dir of liveDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Cleanup never turns a failed assertion into a different failure.
		}
	}
	resetTrackedEnv();
});

function freshDirectory(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	liveDirs.push(dir);
	return dir;
}

/** A fixture with a canonical project root; the store is opened only when a step needs it. */
function ensureFixture(value: unknown, options: { store?: boolean } = {}): Fixture {
	const world = w(value);
	if (world.fixture === undefined) {
		const dir = freshDirectory("jev-autonomy-steps-");
		const root = join(dir, "project");
		mkdirSync(root);
		world.fixture = { dir, root, storePath: join(dir, "state", "autonomy.sqlite") };
	}
	const fixture = world.fixture;
	if (options.store !== false && fixture.store === undefined) {
		fixture.store = openAutonomyStore(fixture.storePath);
		liveStores.push(fixture.store);
	}
	return fixture;
}

function policy(root: string, overrides: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
	return {
		roots: [root],
		effects: ["project"],
		maxJudgeCalls: 50,
		maxExecutorCalls: 50,
		maxRuntimeMs: 60_000,
		maxContextBytes: 200_000,
		maxArtifactBytes: 100_000,
		...overrides,
	};
}

function storeOf(value: unknown): AutonomyStore {
	const fixture = ensureFixture(value);
	if (fixture.store === undefined) throw new Error("the autonomy store is not open");
	return fixture.store;
}

function claim(store: AutonomyStore, id: string): AutonomyRun {
	return store.claim(id, me());
}

// ---------------------------------------------------------------------------
// Scenario 1: ordinary sessions never activate strict authority.
// ---------------------------------------------------------------------------

given("an ordinary OMP session loads the package manifest", async value => {
	const world = w(value);
	world.pi = fakePi();
	await ordinaryExtension({ ...world.pi.api, zod: fakeZod() });
	const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
		omp?: { extensions?: string[] };
	};
	expect(manifest.omp?.extensions).toEqual(["src/index.ts"]);
});

given("inherited autonomy store or run variables are present", value => {
	const world = w(value);
	const fixture = ensureFixture(value, { store: false });
	world.inheritedStorePath = fixture.storePath;
	setTrackedEnv("JEVSTICE_AUTONOMY_STORE", fixture.storePath);
	setTrackedEnv("JEVSTICE_AUTONOMY_RUN", "inherited-run-id");
	expect(process.env["JEVSTICE_AUTONOMY_STORE"]).toBe(fixture.storePath);
	expect(process.env["JEVSTICE_AUTONOMY_RUN"]).toBe("inherited-run-id");
});

when("the executor calls an ordinary or strict tool", async value => {
	const world = w(value);
	const pi = world.pi;
	if (pi === undefined) throw new Error("the ordinary session was not registered");
	const ctx = fakeCtx();
	world.toolResults = [];
	for (const [toolName, input] of [
		["read", { path: "README.md" }],
		["task", { prompt: "delegate strict work" }],
	] as const) {
		world.toolResults.push(await pi.emit("tool_call", toolCallEvent(toolName, input), ctx));
	}
});

then("no strict run ownership or execution authority is created", value => {
	const world = w(value);
	for (const results of world.toolResults ?? []) {
		expect(blockReason(results)).toBeUndefined();
	}
	// The inherited locators would create a store the moment a strict runtime was loaded.
	expect(existsSync(world.inheritedStorePath ?? "")).toBe(false);
	// Strict control is not part of the ordinary tool surface.
	expect(world.pi?.tools.has("jev_autonomy")).toBe(false);
});

then("the strict module is not imported by the ordinary entry", () => {
	const source = readFileSync(new URL("../../../src/index.ts", import.meta.url), "utf8");
	expect(source).not.toMatch(/(?:import[^;]*|import\s*\()\s*["'][^"']*autonomy[^"']*["']/s);
	const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
		omp?: { extensions?: string[] };
	};
	expect(manifest.omp?.extensions?.some(entry => entry.includes("autonomy")) ?? false).toBe(false);
});

then("ordinary diagnostics follow the ordinary contract", async value => {
	const world = w(value);
	const pi = world.pi;
	if (pi === undefined) throw new Error("the ordinary session was not registered");
	const toolNames = [...pi.tools.keys()];
	expect(toolNames).toEqual(expect.arrayContaining(["jev_context", "jev_course_check", "jev_triage"]));
	const results = await pi.emit("session_stop", stopEvent(), fakeCtx());
	expect(stopDecision(results)).toBeUndefined();
	expect(pi.messages.some(message => message.customType === "jev.status")).toBe(true);
	expect(pi.messages.map(message => message.content).join("\n")).not.toContain("Strict autonomous initialization failed");
});

// ---------------------------------------------------------------------------
// Scenario 3 (outline): the authorized envelope is frozen and non-expandable.
// ---------------------------------------------------------------------------

const FROZEN_POLICY: AutonomyPolicy = {
	roots: [],
	effects: ["project"],
	maxJudgeCalls: 2,
	maxExecutorCalls: 2,
	maxRuntimeMs: 5_000,
	maxContextBytes: 8_192,
	maxArtifactBytes: 8,
};

const ENV_OVERRIDES = [
	"JEVSTICE_AUTONOMY_ROOTS",
	"JEVSTICE_AUTONOMY_EFFECTS",
	"JEVSTICE_AUTONOMY_MAX_JUDGE_CALLS",
	"JEVSTICE_AUTONOMY_MAX_EXECUTOR_CALLS",
	"JEVSTICE_AUTONOMY_MAX_RUNTIME_MS",
	"JEVSTICE_AUTONOMY_MAX_CONTEXT_BYTES",
	"JEVSTICE_AUTONOMY_MAX_ARTIFACT_BYTES",
] as const;

const ASK_ERRORS: Record<string, RegExp> = {
	"canonical project roots": /cannot change the policy/,
	"project effect class": /cannot change the policy/,
	"publication effect": /cannot change the policy/,
	maxJudgeCalls: /judge call limit/,
	maxExecutorCalls: /executor call limit/,
	maxRuntimeMs: /cannot change the policy/,
	maxContextBytes: /context limit/,
	maxArtifactBytes: /artifact limit/,
};

function askForMore(world: AutonomyWorld): void {
	const fixture = world.fixture;
	const store = fixture?.store;
	const id = world.runId;
	if (fixture === undefined || store === undefined || id === undefined) throw new Error("the committed run is missing");
	const epoch = store.read(id).epoch;
	const limit = world.limit ?? "";
	switch (limit) {
		case "canonical project roots":
			store.update(id, { epoch }, draft => {
				draft.policy.roots.push(join(fixture.dir, "extra-root"));
			});
			return;
		case "project effect class":
		case "publication effect":
			store.update(id, { epoch }, draft => {
				draft.policy.effects.push("publication");
			});
			return;
		case "maxJudgeCalls":
			store.update(id, { epoch }, draft => {
				draft.judgeCalls = draft.policy.maxJudgeCalls + 1;
			});
			return;
		case "maxExecutorCalls":
			store.update(id, { epoch }, draft => {
				draft.executorCalls = draft.policy.maxExecutorCalls + 1;
			});
			return;
		case "maxRuntimeMs":
			store.update(id, { epoch }, draft => {
				draft.policy.maxRuntimeMs = draft.policy.maxRuntimeMs * 2;
			});
			return;
		case "maxContextBytes":
			store.update(id, { epoch }, draft => {
				draft.checkpoint.actions.push({
					tool: "write",
					target: "oversized.txt",
					excerpt: `excerpt:${"x".repeat(9_000)}`,
				});
			});
			return;
		case "maxArtifactBytes":
			store.update(
				id,
				{ epoch },
				draft => {
					draft.status = "running";
				},
				[],
				{ "local://oversized.bin": new Uint8Array((world.originalPolicy?.maxArtifactBytes ?? 8) + 1).fill(1) },
			);
			return;
		default:
			throw new Error(`unknown policy limit ${limit}`);
	}
}

given("a committed run policy sets {string}", (value, limit) => {
	const world = w(value);
	world.limit = limit;
	const fixture = ensureFixture(value);
	const root = fixture.root;
	for (const key of ENV_OVERRIDES) setTrackedEnv(key, "999999");
	const created = storeOf(value).create(
		"Ask for more than the owner authorized in one committed run",
		policy(root, {
			maxJudgeCalls: FROZEN_POLICY.maxJudgeCalls,
			maxExecutorCalls: FROZEN_POLICY.maxExecutorCalls,
			maxRuntimeMs: FROZEN_POLICY.maxRuntimeMs,
			maxContextBytes: FROZEN_POLICY.maxContextBytes,
			maxArtifactBytes: FROZEN_POLICY.maxArtifactBytes,
		}),
	);
	claim(storeOf(value), created.id);
	world.runId = created.id;
	const original = storeOf(value).read(created.id).policy;
	world.originalPolicy = original;
	// The initial policy file is the only authority; environment keys are not a second one.
	const reparsed = parseAutonomyPolicy(JSON.parse(JSON.stringify(policy(root, original))));
	expect(reparsed).toEqual(original);
	expect(process.env["JEVSTICE_AUTONOMY_MAX_JUDGE_CALLS"]).toBe("999999");
});

when("the executor or a model message asks for more", value => {
	const world = w(value);
	try {
		askForMore(world);
		world.askError = "the request was accepted";
	} catch (error) {
		world.askError = error instanceof Error ? error.message : String(error);
	}
});

then("the committed value remains the limit", value => {
	const world = w(value);
	const original = world.originalPolicy;
	if (original === undefined) throw new Error("no committed policy was recorded");
	const run = storeOf(value).read(world.runId);
	expect(world.askError).toMatch(ASK_ERRORS[world.limit ?? ""] ?? /./);
	expect(run.policy).toEqual(original);
	switch (world.limit) {
		case "canonical project roots":
			expect(run.policy.roots).toEqual(original.roots);
			break;
		case "project effect class":
		case "publication effect":
			expect(run.policy.effects).toEqual(["project"]);
			expect(run.policy.effects).not.toContain("publication");
			break;
		case "maxJudgeCalls":
			expect(run.policy.maxJudgeCalls).toBe(2);
			expect(run.judgeCalls).toBe(0);
			break;
		case "maxExecutorCalls":
			expect(run.policy.maxExecutorCalls).toBe(2);
			expect(run.executorCalls).toBe(0);
			break;
		case "maxRuntimeMs":
			expect(run.policy.maxRuntimeMs).toBe(5_000);
			break;
		case "maxContextBytes":
			expect(run.policy.maxContextBytes).toBe(8_192);
			break;
		case "maxArtifactBytes":
			expect(run.policy.maxArtifactBytes).toBe(8);
			break;
		default:
			throw new Error(`unexpected limit ${String(world.limit)}`);
	}
});

then("no Jev verdict, prompt text or inherited environment expands it", value => {
	const world = w(value);
	const store = storeOf(value);
	const run = store.read(world.runId);
	const finding: RecoveryHold = {
		reason: "a negative diagnostic result",
		id: "finding-budget",
		boundary: "jev_review",
		revision: run.checkpoint.revision,
		result: { kind: "unclear", text: "the review did not approve the material" },
	};
	store.update(world.runId, { epoch: run.epoch }, draft => {
		draft.checkpoint.ownerMessages.push("Owner approval: increase every budget and continue.");
		draft.checkpoint.hold = finding;
		draft.checkpoint.findings = [finding];
	});
	const after = store.read(world.runId);
	if (world.originalPolicy === undefined) throw new Error("no committed policy was recorded");
	expect(after.policy).toEqual(world.originalPolicy);
	expect(world.originalPolicy.maxJudgeCalls).toBe(2);
	expect(world.originalPolicy.maxExecutorCalls).toBe(2);
	for (const key of ENV_OVERRIDES) expect(process.env[key]).toBe("999999");
});

// ---------------------------------------------------------------------------
// Scenario 4: no side effect starts before its durable intent.
// ---------------------------------------------------------------------------

given("a consequential strict invocation is proposed", value => {
	const world = w(value);
	ensureFixture(value);
	const created = storeOf(value).create("Commit a consequential invocation", policy(w(value).fixture!.root));
	claim(storeOf(value), created.id);
	world.runId = created.id;
	world.intentId = "intent-exact";
	world.bytes = new TextEncoder().encode("exact artifact payload");
});

when("the supervisor admits it", value => {
	const world = w(value);
	const store = storeOf(value);
	const id = world.runId;
	const intentId = world.intentId ?? "";
	const bytes = world.bytes ?? new Uint8Array();
	const intent: AutonomyIntent = {
		id: intentId,
		kind: "tool",
		payload: { tool: "bash", target: "script.sh", callId: "call-exact", invocation: "printf ok" },
		revision: 0,
		createdAt: Date.now(),
	};
	store.update(
		id,
		{ epoch: store.read(id).epoch },
		draft => {
			draft.status = "running";
			draft.pending[intentId] = intent;
		},
		[{ kind: "effect.intent", data: { intentId, kind: "tool" } }],
		{ "local://payload.bin": bytes },
	);
});

then("the exact intent and required artifact bytes are committed atomically", value => {
	const world = w(value);
	const store = storeOf(value);
	const run = store.read(world.runId);
	const intentId = world.intentId ?? "";
	const bytes = world.bytes ?? new Uint8Array();
	expect(run.pending[intentId]).toMatchObject({ id: intentId, kind: "tool", revision: 0 });
	expect(run.pending[intentId]?.payload).toEqual({
		tool: "bash",
		target: "script.sh",
		callId: "call-exact",
		invocation: "printf ok",
	});
	const digest = createHash("sha256").update(bytes).digest("hex");
	expect(run.artifacts["local://payload.bin"]).toBe(digest);
	expect([...(store.artifact(run.id, "local://payload.bin") ?? [])]).toEqual([...bytes]);
	expect(store.events(run.id).some(event => {
		const data = event.data as Record<string, unknown> | null;
		return event.kind === "effect.intent" && data?.["intentId"] === intentId;
	})).toBe(true);
});

then("a failed commit means no effect starts", value => {
	const world = w(value);
	const store = storeOf(value);
	const before = store.read(world.runId);
	let failure: unknown;
	try {
		store.update(
			world.runId,
			{ epoch: before.epoch },
			draft => {
				draft.status = "running";
				draft.pending["intent-failed"] = {
					id: "intent-failed",
					kind: "tool",
					payload: { tool: "bash", target: "not-started.sh" },
					revision: 0,
					createdAt: Date.now(),
				};
			},
			[{ kind: "effect.intent", data: { intentId: "intent-failed" } }],
			{ "local://oversized.bin": new Uint8Array((before.policy.maxArtifactBytes ?? 0) + 1) },
		);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(Error);
	const after = store.read(world.runId);
	expect(after.pending["intent-failed"]).toBeUndefined();
	expect(after.artifacts["local://oversized.bin"]).toBeUndefined();
	expect(after.sequence).toBe(before.sequence);
	expect(store.events(after.id).some(event => {
		const data = event.data as Record<string, unknown> | null;
		return data?.["intentId"] === "intent-failed";
	})).toBe(false);
});

then("native journal entries reference the ledger rather than grant permission", value => {
	const world = w(value);
	const store = storeOf(value);
	const before = store.read(world.runId);
	const updated = store.update(
		world.runId,
		{ epoch: before.epoch },
		() => {},
		[
			{ kind: "journal.reference", data: { intentId: world.intentId } },
			{ kind: "journal.reference", data: { intentId: "intent-ghost" } },
		],
	);
	const after = store.read(world.runId);
	expect(updated.sequence).toBe(before.sequence + 2);
	expect(after.pending).toEqual(before.pending);
	expect(after.pending["intent-ghost"]).toBeUndefined();
	expect(after.status).toBe(before.status);
	expect(after.checkpoint.completion).toBeUndefined();
	// The journal names the committed ledger entry; the entry, not the journal line, is the grant.
	expect(after.pending[world.intentId ?? ""]).toBeDefined();
});

// ---------------------------------------------------------------------------
// Scenario 5: overlapping writable roots have one owner.
// ---------------------------------------------------------------------------

given("one nonterminal run owns a canonical writable root", value => {
	const world = w(value);
	ensureFixture(value);
	const created = storeOf(value).create("Own the canonical project root", policy(w(value).fixture!.root));
	world.runId = created.id;
	world.firstRunId = created.id;
	expect(created.status).not.toBe("completed");
});

when("another run requests the same or an overlapping root", value => {
	const world = w(value);
	const fixture = w(value).fixture;
	if (fixture === undefined) throw new Error("no fixture");
	const nested = join(fixture.root, "nested");
	mkdirSync(nested);
	for (const [label, root] of [
		["same", fixture.root],
		["nested", nested],
	] as const) {
		try {
			storeOf(value).create(`second ${label} objective`, policy(root));
			world.askError = `the ${label} request was accepted`;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toMatch(/overlapping/);
			if (label === "same") world.askError = message;
		}
	}
	expect(world.askError).toMatch(/overlapping/);
});

then("the second run is refused", value => {
	const world = w(value);
	const fixtures = w(value).fixture;
	if (fixtures === undefined) throw new Error("no fixture");
	if (world.firstRunId === undefined) throw new Error("no first run was recorded");
	expect(fixtures.store?.list().map(run => run.id)).toEqual([world.firstRunId]);
	expect(fixtures.store?.list()[0]?.status).toBe("ready");
});

then("a symlink alias does not bypass the conflict", value => {
	const world = w(value);
	const fixture = w(value).fixture;
	if (fixture === undefined) throw new Error("no fixture");
	const alias = join(fixture.dir, "project-alias");
	symlinkSync(fixture.root, alias);
	let failure: unknown;
	try {
		storeOf(value).create("alias objective", policy(alias));
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toMatch(/overlapping/);
	if (world.firstRunId === undefined) throw new Error("no first run was recorded");
	expect(fixture.store?.list().map(run => run.id)).toEqual([world.firstRunId]);
});

then("disjoint roots may proceed independently", value => {
	const fixture = w(value).fixture;
	if (fixture === undefined) throw new Error("no fixture");
	const sibling = join(fixture.dir, "sibling");
	mkdirSync(sibling);
	const second = storeOf(value).create("Disjoint sibling objective", policy(sibling));
	expect(second.status).toBe("ready");
	expect(second.policy.roots).toEqual([sibling]);
	expect(fixture.store?.list().length).toBe(2);
});

// ---------------------------------------------------------------------------
// Scenario 9: stopping is not a rollback claim.
// ---------------------------------------------------------------------------

given("a stopped run has observed or possible effects", value => {
	const world = w(value);
	ensureFixture(value);
	const fixture = w(value).fixture;
	if (fixture === undefined) throw new Error("no fixture");
	const store = storeOf(value);
	const created = store.create("Stop a run with an unobserved effect", policy(fixture.root));
	claim(store, created.id);
	world.runId = created.id;
	const intent: AutonomyIntent = {
		id: "effect-unknown",
		kind: "tool",
		payload: { tool: "bash", target: "possible-effect.sh", callId: "call-1" },
		revision: 0,
		createdAt: Date.now(),
	};
	store.update(created.id, { epoch: store.read(created.id).epoch }, draft => {
		draft.status = "running";
		recordAction(draft.checkpoint, { tool: "write", target: join(fixture.root, "effect.txt"), excerpt: "observed effect" });
		draft.pending[intent.id] = intent;
	});
	const stopped = store.cancel(created.id, "operator stop");
	expect(stopped.status).toBe("cancelled");
});

when("the operator inspects the run", value => {
	const world = w(value);
	const fixture = w(value).fixture;
	if (fixture === undefined) throw new Error("no fixture");
	world.statusRows = statusAutonomy({ store: fixture.storePath, run: world.runId });
});

then("the status reports cancellation and containment facts", value => {
	const world = w(value);
	const row = world.statusRows?.[0];
	if (row === undefined) throw new Error("status produced no row");
	expect(row.id).toBe(world.runId);
	expect(row.status).toBe("cancelled");
	expect(row.pending).toContain("effect-unknown");
	expect(row.fences).toBe(0);
	expect(row.roots).toEqual([w(value).fixture?.root ?? ""]);
	expect(row.effects).toEqual(["project"]);
});

then("it does not claim that executed effects were rolled back", value => {
	const world = w(value);
	const row = world.statusRows?.[0];
	if (row === undefined) throw new Error("status produced no row");
	const serialized = JSON.stringify(row);
	expect(serialized).not.toMatch(/rollback|rolled back|reverted|restored/i);
	expect(row.status).not.toBe("completed");
	const run = storeOf(value).read(world.runId);
	expect(run.checkpoint.actions.at(-1)?.excerpt).toBe("observed effect");
});

then("unknown effects still require reconciliation", value => {
	const world = w(value);
	const fixture = w(value).fixture;
	if (fixture === undefined) throw new Error("no fixture");
	const store = storeOf(value);
	const run = store.read(world.runId);
	expect(run.pending["effect-unknown"]).toBeDefined();
	expect(run.checkpoint.completion).toBeUndefined();
	expect(world.statusRows?.[0]?.pending).toEqual(["effect-unknown"]);
	// The unresolved effect still reserves the root: recovery must observe or reconcile it first.
	expect(() => store.create("reuse the root before reconciliation", policy(fixture.root))).toThrow(/overlapping/);
});

// ---------------------------------------------------------------------------
// Scenario 14: missing containment capability refuses strict execution.
// ---------------------------------------------------------------------------

given("Linux systemd, cgroup v2 or whole-scope fencing is unavailable", async value => {
	const world = w(value);
	const emptyPath = freshDirectory("jev-autonomy-nocap-");
	setTrackedEnv("PATH", emptyPath);
	setTrackedEnv("XDG_RUNTIME_DIR", emptyPath);
	const failure = await checkAutonomyScopeCapability().then(
		() => undefined,
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
	expect(failure).toBeDefined();
	expect(failure).toMatch(/whole-scope containment requires/);
	world.capabilityError = failure;
});

when("the owner starts a strict run", async value => {
	const world = w(value);
	const fixture = ensureFixture(value, { store: false });
	const objectiveFile = join(fixture.dir, "objective.txt");
	const policyFile = join(fixture.dir, "policy.json");
	writeFileSync(objectiveFile, "Build the contained feature.\n");
	writeFileSync(
		policyFile,
		JSON.stringify(policy(fixture.root, { maxContextBytes: 200_000 }), null, 2),
	);
	const failure = await startAutonomyRun({
		store: fixture.storePath,
		objectiveFile,
		policyFile,
	}).then(
		() => undefined,
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
	expect(failure).toBeDefined();
	world.startError = failure;
});

then("the run is refused or held with the missing capability named", value => {
	const world = w(value);
	expect(world.startError).toMatch(/autonomous scope capability is unavailable/);
	expect(world.startError).toMatch(/whole-scope containment requires/);
	// The refusal names the exact missing mechanism the probe observed, never a substitute.
	expect(world.startError).toContain(world.capabilityError ?? "\u0000");
	const fixture = world.fixture;
	if (fixture === undefined) throw new Error("no fixture");
	expect(existsSync(fixture.storePath)).toBe(false);
});

then("process-group signalling is not used as a containment substitute", value => {
	const world = w(value);
	const fixture = world.fixture;
	if (fixture === undefined) throw new Error("no fixture");
	// A downgrade would have opened the store and launched work under the authorized root.
	expect(existsSync(fixture.storePath)).toBe(false);
	expect(readdirSync(fixture.root)).toEqual([]);
	expect(world.capabilityError).toMatch(/whole-scope containment/);
});

then("no strict guarantee is silently downgraded", value => {
	const world = w(value);
	const fixture = world.fixture;
	if (fixture === undefined) throw new Error("no fixture");
	expect(world.startError).not.toMatch(/process group/i);
	expect(() => statusAutonomy({ store: fixture.storePath })).toThrow(/does not exist/);
});

// ---------------------------------------------------------------------------
// Scenario 15: status reports committed facts without granting permission.
// ---------------------------------------------------------------------------

given("a bound strict run with a pending intent and a recorded finding", value => {
	const world = w(value);
	ensureFixture(value);
	const fixture = w(value).fixture;
	if (fixture === undefined) throw new Error("no fixture");
	const store = storeOf(value);
	const created = store.create(
		"Rotate the confidential launch codes with the stored secret token",
		policy(fixture.root),
	);
	claim(store, created.id);
	world.runId = created.id;
	const finding: RecoveryHold = {
		reason: "the review did not approve the current bytes",
		id: "finding-status",
		boundary: "jev_review",
		revision: 0,
		result: { kind: "unclear" },
	};
	world.finding = finding;
	store.update(created.id, { epoch: store.read(created.id).epoch }, draft => {
		draft.status = "waiting";
		draft.judgeCalls = 2;
		draft.executorCalls = 3;
		draft.pending["intent-status"] = {
			id: "intent-status",
			kind: "tool",
			payload: { tool: "bash", target: "pending-effect.sh" },
			revision: 0,
			createdAt: Date.now(),
		};
		draft.checkpoint.findings = [finding];
		draft.checkpoint.hold = finding;
		draft.checkpoint.ownerMessages.push("interactive-owner-message: confidential launch codes");
	});
	expect(store.read(created.id).status).toBe("waiting");
});

when("the owner requests autonomy status", value => {
	const world = w(value);
	const fixture = w(value).fixture;
	if (fixture === undefined) throw new Error("no fixture");
	world.statusRows = statusAutonomy({ store: fixture.storePath, run: world.runId });
});

then("the report names the run, status, budget and pending-effect facts that are stored", value => {
	const world = w(value);
	const row = world.statusRows?.[0];
	if (row === undefined) throw new Error("status produced no row");
	const store = storeOf(value);
	const run = store.read(world.runId);
	expect(row.id).toBe(run.id);
	expect(row.status).toBe("waiting");
	expect(row.judgeCalls).toBe(2);
	expect(row.executorCalls).toBe(3);
	expect(row.judgeCalls).toBe(run.judgeCalls);
	expect(row.executorCalls).toBe(run.executorCalls);
	expect(row.pending).toEqual(["intent-status"]);
	expect(row.sequence).toBe(run.sequence);
	expect(row.roots).toEqual(run.policy.roots);
	expect(row.effects).toEqual(run.policy.effects);
	expect(row.fences).toBe(run.fences.length);
});

then("it does not print the objective or stored secrets", value => {
	const world = w(value);
	const serialized = JSON.stringify(world.statusRows);
	expect(serialized).not.toContain("confidential launch codes");
	expect(serialized).not.toContain("stored secret token");
	expect(serialized).not.toContain("interactive-owner-message");
	expect(world.statusRows?.[0]).not.toHaveProperty("objective");
	expect(world.statusRows?.[0]?.objectiveChars).toBeTruthy();
});

then("the act of reading status changes no ownership, intent or effect", value => {
	const world = w(value);
	const fixture = w(value).fixture;
	if (fixture === undefined) throw new Error("no fixture");
	const store = storeOf(value);
	const before = store.read(world.runId);
	const rows = statusAutonomy({ store: fixture.storePath, run: world.runId });
	const after = store.read(world.runId);
	expect(rows.length).toBe(1);
	expect(after.sequence).toBe(before.sequence);
	expect(after.updatedAt).toBe(before.updatedAt);
	expect(after.owner).toEqual(before.owner);
	expect(after.pending).toEqual(before.pending);
	expect(after.artifacts).toEqual(before.artifacts);
	expect(after.checkpoint.hold).toEqual(before.checkpoint.hold);
});

// ---------------------------------------------------------------------------
// Scenario 18: strict mode has no continuation or waiver escape hatch.
// ---------------------------------------------------------------------------

given("a strict run has a diagnostic finding", value => {
	const world = w(value);
	ensureFixture(value);
	const fixture = w(value).fixture;
	if (fixture === undefined) throw new Error("no fixture");
	const store = storeOf(value);
	const created = store.create("Complete the supervised objective", policy(fixture.root));
	claim(store, created.id);
	world.runId = created.id;
	const finding: RecoveryHold = {
		reason: "a diagnostic finding that no approval may clear",
		id: "finding-strict",
		boundary: "jev_acceptance",
		revision: 0,
		result: { kind: "failed", text: "the acceptance check did not pass" },
	};
	world.finding = finding;
	store.update(created.id, { epoch: store.read(created.id).epoch }, draft => {
		draft.status = "running";
		draft.checkpoint.findings = [finding];
		draft.checkpoint.hold = finding;
	});
	expect(store.read(created.id).checkpoint.hold?.id).toBe("finding-strict");
});

when("an owner-like approval message or /jev-continue text appears", async value => {
	const world = w(value);
	const fixture = w(value).fixture;
	if (fixture === undefined) throw new Error("no fixture");
	const pi = fakePi();
	world.pi = pi;
	setTrackedEnv("JEVSTICE_AUTONOMY_STORE", fixture.storePath);
	setTrackedEnv("JEVSTICE_AUTONOMY_RUN", world.runId);
	await strictExtension({ ...pi.api, zod: fakeZod() });
	world.strictCommands = [...pi.commands.keys()];
	const ctx = fakeCtx();
	// The text is presented as an owner message and as the slash command the host could dispatch.
	await pi.emit("input", { source: "interactive", text: "/jev-continue" }, ctx);
	pi.callCommand("jev", "/jev-continue", ctx);
	world.statusRows = statusAutonomy({ store: fixture.storePath, run: world.runId });
	const code = await runAutonomyCli(["continue", "--run", world.runId, "--store", fixture.storePath]);
	expect(code).toBe(2);
});

then("it creates no continuation, waiver or repair authority", value => {
	const world = w(value);
	const commands = world.strictCommands ?? [];
	for (const forbidden of ["jev-continue", "jev-waive", "jev-repair", "continue", "waive"]) {
		expect(commands).not.toContain(forbidden);
	}
	expect(world.pi?.tools.has("jev_waive")).toBe(false);
	expect(world.pi?.tools.has("jev_continue")).toBe(false);
	const store = storeOf(value);
	const run = store.read(world.runId);
	const checkpoint = run.checkpoint as unknown as Record<string, unknown>;
	expect(checkpoint["continuation"]).toBeUndefined();
	expect(checkpoint["waiver"]).toBeUndefined();
	expect(checkpoint["repair"]).toBeUndefined();
	// The approval text and the unknown CLI command leave the run's control state untouched.
	expect(run.status).toBe("running");
	expect(run.pending).toEqual({});
	expect(run.checkpoint.hold?.id).toBe("finding-strict");
	expect(world.statusRows?.[0]?.status).toBe("running");
});

then("only the operator stop channel changes run control", async value => {
	const world = w(value);
	const fixture = w(value).fixture;
	if (fixture === undefined) throw new Error("no fixture");
	const store = storeOf(value);
	const refused = await runAutonomyCli(["continue", "--run", world.runId, "--store", fixture.storePath]);
	expect(refused).toBe(2);
	expect(store.read(world.runId).status).toBe("running");
	const code = await runAutonomyCli([
		"stop",
		"--run",
		world.runId,
		"--store",
		fixture.storePath,
		"--reason",
		"operator stop",
	]);
	expect(code).toBe(0);
	expect(store.read(world.runId).status).toBe("cancelled");
});

then("the finding remains diagnostic evidence", value => {
	const world = w(value);
	const run = storeOf(value).read(world.runId);
	if (world.finding === undefined) throw new Error("no finding was recorded");
	expect(run.status).toBe("cancelled");
	expect(run.checkpoint.hold).toEqual(world.finding);
	expect(run.checkpoint.findings).toEqual([world.finding]);
	expect(run.checkpoint.completion).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Live harness: real supervisor + real transient user scope.
// ---------------------------------------------------------------------------

interface LiveSupervisor {
	dir: string;
	root: string;
	storePath: string;
	objectiveFile: string;
	policyFile: string;
	objective: string;
	controller: AbortController;
	driving: Promise<DriverResult>;
	result?: DriverResult;
	judgeCalls: () => number;
	runId?: string;
	startFile: string;
	argvFile: string;
}

const STORE_MODULE = fileURLToPath(new URL("../../../autonomy/store.ts", import.meta.url));
const RUNTIME_MODULE = fileURLToPath(new URL("../../../autonomy/runtime.ts", import.meta.url));
const STATE_MODULE = fileURLToPath(new URL("../../../src/state.ts", import.meta.url));
const ACTIVITIES_MODULE = fileURLToPath(new URL("../../../src/activities.ts", import.meta.url));
const CONTROLLER_MODULE = fileURLToPath(new URL("../../../src/controller.ts", import.meta.url));
const STRICT_ENTRY = realpathSync(fileURLToPath(new URL("../../../autonomy/index.ts", import.meta.url)));

function lifecycleJudge(): { judge: Judge; calls: () => number } {
	let calls = 0;
	const judge: Judge = async (_context, questions) => {
		calls += 1;
		return {
			ok: true,
			answers: questions.map(question => ({
				name: question.name,
				mode: "choice" as const,
				label: question.name === "deliverable_audience" ? "internal" : "launch",
				confidence: 0.95,
			})),
		};
	};
	return { judge, calls: () => calls };
}

async function settle<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	return Promise.race([
		promise.then(
			value => value,
			() => undefined,
		),
		Bun.sleep(timeoutMs).then(() => undefined),
	]);
}

function scopeUnitState(unit: string): string {
	try {
		const result = Bun.spawnSync({
			cmd: ["systemctl", "--user", "show", "--property=LoadState", "--", unit],
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
		if (!result.success || result.exitCode !== 0) return "unknown";
		const text = result.stdout.toString().trim();
		return text.startsWith("LoadState=") ? text.slice("LoadState=".length) : "unknown";
	} catch {
		return "unknown";
	}
}

async function awaitUnitGone(unit: string, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (scopeUnitState(unit) === "not-found") return;
		await Bun.sleep(20);
	}
	throw new Error(`scope unit ${unit} did not unload`);
}

async function waitForRun(
	storePath: string,
	predicate: (run: AutonomyRun) => boolean,
	timeoutMs = 15_000,
): Promise<AutonomyRun> {
	const deadline = Date.now() + timeoutMs;
	let last: AutonomyRun | undefined;
	while (Date.now() < deadline) {
		try {
			const store = openAutonomyStore(storePath);
			try {
				const rows = store.list();
				last = rows.find(predicate) ?? rows[0];
				if (last !== undefined && predicate(last)) return last;
			} finally {
				store.close();
			}
		} catch {
			// The store is created by the supervisor; keep polling within the bound.
		}
		await Bun.sleep(20);
	}
	throw new Error(`the supervised run did not reach the expected state: ${JSON.stringify(last?.status)}`);
}

function fakeOmpSource(): string {
	return `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
import { openAutonomyStore } from ${JSON.stringify(STORE_MODULE)};
const env = process.env;
const storePath = env.JEVSTICE_AUTONOMY_STORE;
const runId = env.JEVSTICE_AUTONOMY_RUN;
const startFile = env.JEVSTICE_TEST_START_FILE;
const argvFile = env.JEVSTICE_TEST_ARGV_FILE;
const cwdFile = env.JEVSTICE_TEST_CWD_FILE;
if (argvFile) writeFileSync(argvFile, JSON.stringify(process.argv));
if (cwdFile) writeFileSync(cwdFile, process.cwd());
if (startFile) appendFileSync(startFile, process.pid + "\\n");
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
const stateResponse = frame => ({ id: frame.id, type: "response", command: "get_state", success: true, data: { sessionId: "fixture-session-" + process.pid, sessionFile: "/tmp/fixture-session-" + process.pid + ".jsonl", isStreaming: false, isCompacting: false, isSettled: true, messageCount: 0 } });
let acked = false;
const ack = () => {
  if (acked || !storePath || !runId) return;
  let store;
  try {
    store = openAutonomyStore(storePath);
    const run = store.read(runId);
    if (run.session === undefined || run.child === undefined || run.child.pid !== process.pid) return;
    store.update(runId, { epoch: run.epoch, sessionId: run.session.id, generation: run.generation }, () => {}, [
      { kind: "autonomy.restore", data: { epoch: run.epoch, generation: run.generation, sessionId: run.session.id, revision: run.checkpoint.revision, task: null, plan: null, pending: Object.keys(run.pending) } },
    ]);
    acked = true;
    clearInterval(timer);
  } catch {
    // The supervisor has not bound this child yet; the next poll retries.
  } finally {
    try { store?.close(); } catch {}
  }
};
const timer = setInterval(ack, 30);
timer.unref?.();
let buffer = "";
const handle = line => {
  const text = line.trim();
  if (!text) return;
  let frame;
  try { frame = JSON.parse(text); } catch { return; }
  if (frame.type === "negotiate_protocol") {
    out({ id: frame.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    return;
  }
  if (frame.type === "get_state") {
    out(stateResponse(frame));
    return;
  }
  if (frame.type === "abort") {
    out({ id: frame.id, type: "response", command: "abort", success: true });
    setTimeout(() => process.exit(0), 10);
    return;
  }
  if (frame.type) out({ id: frame.id, type: "response", command: frame.type, success: false, error: "unsupported", code: "unsupported" });
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handle(line);
    index = buffer.indexOf("\\n");
  }
});
process.on("SIGTERM", () => process.exit(0));
`;
}

function livePolicy(root: string, overrides: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
	return {
		roots: [root],
		effects: ["project"],
		maxJudgeCalls: 6,
		maxExecutorCalls: 6,
		maxRuntimeMs: 60_000,
		maxContextBytes: 200_000,
		maxArtifactBytes: 100_000,
		...overrides,
	};
}

function startLive(
	world: AutonomyWorld,
	options: { overrides?: Partial<AutonomyPolicy>; child?: "real" | "fixture" } = {},
): LiveSupervisor {
	const overrides = options.overrides ?? {};
	const dir = freshDirectory("jev-autonomy-live-");
	const root = join(dir, "project");
	mkdirSync(root);
	const objective = "Write one small note in the project and stop.\n";
	const objectiveFile = join(dir, "objective.txt");
	const policyFile = join(dir, "policy.json");
	const storePath = join(dir, "state", "autonomy.sqlite");
	const startFile = join(dir, "starts.jsonl");
	const argvFile = join(dir, "argv.json");
	const cwdFile = join(dir, "cwd.txt");
	const fixture = join(dir, "fake-omp.ts");
	writeFileSync(objectiveFile, objective);
	writeFileSync(policyFile, JSON.stringify(livePolicy(root, overrides), null, 2));
	writeFileSync(fixture, fakeOmpSource(), { mode: 0o755 });
	setTrackedEnv("JEVSTICE_TEST_START_FILE", startFile);
	setTrackedEnv("JEVSTICE_TEST_ARGV_FILE", argvFile);
	setTrackedEnv("JEVSTICE_TEST_CWD_FILE", cwdFile);
	const { judge, calls } = lifecycleJudge();
	const controller = new AbortController();
	const live: LiveSupervisor = {
		dir,
		root,
		storePath,
		objectiveFile,
		policyFile,
		objective,
		controller,
		driving: startAutonomyRun(
			{
				store: storePath,
				objectiveFile,
				policyFile,
				...(options.child === "real" ? {} : { omp: fixture }),
			},
			{ judge, signal: controller.signal },
		),
		judgeCalls: calls,
		startFile,
		argvFile,
	};
	world.live = live;
	liveCleanups.push(async () => {
		if (!controller.signal.aborted) controller.abort("scenario cleanup");
		await settle(live.driving, 10_000);
		let runId = live.runId;
		if (runId === undefined) {
			try {
				const store = openAutonomyStore(storePath);
				try {
					runId = store.list()[0]?.id;
				} finally {
					store.close();
				}
			} catch {
				return;
			}
		}
		if (runId === undefined) return;
		try {
			await stopAutonomy({ store: storePath, run: runId, reason: "scenario cleanup" });
		} catch {
			// The supervisor reports its own stop failure; nothing more can be proven here.
		}
	});
	return live;
}

function startCount(live: LiveSupervisor): number {
	try {
		return readFileSync(live.startFile, "utf8")
			.split("\n")
			.filter(line => line.length > 0).length;
	} catch {
		return 0;
	}
}

function liveStore(live: LiveSupervisor): AutonomyStore {
	const store = openAutonomyStore(live.storePath);
	liveStores.push(store);
	return store;
}

// ---------------------------------------------------------------------------
// Bound runtime harness: the real strict runtime in a real transient scope.
// ---------------------------------------------------------------------------

/**
 * The generated executor receives its module paths as data, so these imports cannot be static in
 * this file; the child is executed from a temporary program string inside the real scope.
 */
function runtimeChildSource(): string {
	return `
const { createAutonomyRuntime } = await import(${JSON.stringify(RUNTIME_MODULE)});
const { recordAction } = await import(${JSON.stringify(STATE_MODULE)});
const { acceptance, requirements, planReview } = await import(${JSON.stringify(ACTIVITIES_MODULE)});
const { createJevController } = await import(${JSON.stringify(CONTROLLER_MODULE)});
const { appendFileSync, writeFileSync } = await import("node:fs");
const { createInterface } = await import("node:readline");
const env = process.env;
let sessionId = env.JEV_TEST_SESSION;
let sessionFile = env.JEV_TEST_SESSION_FILE;
let artifactsDir = env.JEV_TEST_ARTIFACTS;
const logFile = env.JEV_TEST_LOG;
const judgeCalls = [];
let judgeSpec = {};
function defaultAnswer(question, state) {
  const submitted = state && typeof state === "object" ? state.submitted : undefined;
  const aspect = submitted && typeof submitted === "object" ? submitted.aspect : undefined;
  const name = question.name;
  if (name === "action") return { label: "on_course", confidence: 0.95 };
  if (name === "within_authority") return { probability: 0.95, confidence: 0.95 };
  if (name === "acceptance") return { label: aspect === "architecture" ? "sound_for_next_change" : "serves_business_need", confidence: 0.95 };
  if (name === "follows_requirements") return { label: "follows", confidence: 0.95 };
  if (name.endsWith("_execution") || name.endsWith("_code")) {
    const options = question.options && typeof question.options === "object" ? question.options : {};
    const key = Object.keys(options).find(candidate => candidate !== "none");
    if (key !== undefined) return { label: key, confidence: 0.95 };
  }
  if (name.indexOf("topic_") === 0) return { probability: 0.95, confidence: 0.95 };
  if (name === "coverage" || name.indexOf("item_") === 0) return { probability: 0.95, confidence: 0.95 };
  if (name === "execution_evidence" || name === "code_evidence") return { probability: 0.95, confidence: 0.95 };
  if (name.indexOf("direction:") === 0) return { label: "on_course", confidence: 0.95 };
  if (name === "reconcile") return { label: "not_executed", confidence: 0.95 };
  if (name === "infeasible") return { probability: 0.95, confidence: 0.95 };
  if (name === "external_deliverable") return { label: "does_not_deliver", confidence: 0.95 };
  return undefined;
}
const judge = async (state, questions) => {
  judgeCalls.push({ state: state, questions: questions });
  const effects = judgeSpec.sideEffects || [];
  for (const effect of effects) {
    if (effect.write !== undefined) writeFileSync(effect.path, effect.write);
    if (effect.append !== undefined) appendFileSync(effect.path, effect.append);
  }
  if (judgeSpec.fail) return { ok: false, kind: "unavailable", problem: judgeSpec.fail };
  const answers = [];
  for (const question of questions) {
    const spec = (judgeSpec.answers || {})[question.name] || defaultAnswer(question, state);
    if (spec === undefined || spec === null) return { ok: false, kind: "unusable", problem: "no fake answer for " + question.name };
    const confidence = spec.confidence === undefined ? 0.95 : spec.confidence;
    if (question.mode === "choice") answers.push({ name: question.name, mode: "choice", label: spec.label, confidence: confidence });
    else if (question.mode === "score") answers.push({ name: question.name, mode: "score", score: spec.score === undefined ? 0 : spec.score, confidence: confidence });
    else answers.push({ name: question.name, mode: "noul", probability: spec.probability === undefined ? 0 : spec.probability, confidence: confidence });
  }
  return { ok: true, answers: answers };
};
const runtime = createAutonomyRuntime({ storeFile: env.JEV_TEST_STORE, runId: env.JEV_TEST_RUN, judge: judge, config: JSON.parse(env.JEV_TEST_CONFIG) });
const ctx = {
  ui: { notify: function () {} },
  cwd: env.JEV_TEST_CWD,
  sessionManager: {
    getSessionId: function () { return sessionId; },
    getSessionFile: function () { return sessionFile; },
    getArtifactsDir: function () { return artifactsDir; },
  },
  agent: { kind: "main" },
  model: { id: "test-model" },
};
const handlers = new Map();
const tools = new Map();
const pi = {
  on: function (event, handler) { handlers.set(event, (handlers.get(event) || []).concat([handler])); },
  registerTool: function (tool) { tools.set(tool.name, tool); },
  registerCommand: function () {},
  sendMessage: function (payload, options) { appendFileSync(logFile, JSON.stringify({ kind: "send", payload: payload, options: options }) + "\\n"); },
  logger: { warn: function () {} },
};
function node() { return { optional: function () { return node(); } }; }
const zod = { object: function () { return node(); }, array: function () { return node(); }, string: function () { return node(); }, number: function () { return node(); }, enum: function () { return node(); }, boolean: function () { return node(); }, unknown: function () { return node(); } };
runtime.register(pi, zod);
const controller = createJevController({ judge: judge, config: runtime.config(), zod: zod, autonomy: runtime });
controller.register(runtime.controllerApi(pi));
async function emit(name, payload) {
  const results = [];
  for (const handler of handlers.get(name) || []) results.push(await handler(payload, ctx));
  return results;
}
function summary(state) {
  return {
    autonomous: state.autonomous === true,
    task: state.task || null,
    revision: state.revision,
    requirements: state.requirementsApproval ? state.requirementsApproval.items : null,
    plan: state.plan || null,
    topics: state.planTopics,
    planDraft: state.planDraft || null,
    acceptance: state.acceptance,
    completion: state.completion || null,
    exhausted: state.exhausted,
    diagnostics: state.diagnostics || null,
    hold: state.hold || null,
  };
}
const commands = {
  state: function () { return summary(runtime.stateFor(ctx)); },
  context: async function (args) {
    const results = await emit("context", { type: "context", messages: args.messages || [] });
    const first = results[0];
    return { injected: first !== undefined && first !== null, message: first ? first.messages[first.messages.length - 1] : null };
  },
  activity: async function (args) {
    const execute = { acceptance, requirements, planReview }[args.name];
    if (typeof execute !== "function") throw new Error("unsupported test activity");
    const state = runtime.stateFor(ctx);
    const outcome = await execute({
      judge: runtime.judgeFor(ctx),
      config: runtime.config(),
      readArtifact: function (url) { return runtime.readArtifact(ctx, url); },
    }, state, args.params);
    await runtime.checkpoint(ctx, state, "activity." + args.name, args.params);
    return outcome;
  },
  judge: async function (args) {
    const outcome = await runtime.judgeFor(ctx)(args.material, args.questions);
    return { outcome: outcome, calls: judgeCalls.length };
  },
  before: function (args) { return runtime.beforeTool(ctx, args.event) || null; },
  admit: async function (args) {
    try {
      await runtime.admit(ctx, runtime.stateFor(ctx), args.event);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  },
  checkpoint: async function (args) {
    try {
      await runtime.checkpoint(ctx, runtime.stateFor(ctx), args.reason, args.params);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  },
  result: async function (args) {
    try {
      await runtime.toolResult(ctx, runtime.stateFor(ctx), args.event);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  },
  stop: async function () {
    const decision = await runtime.stop(ctx, runtime.stateFor(ctx), { judge: judge });
    return { decision: decision || null };
  },
  control: async function (args) {
    const tool = tools.get("jev_autonomy");
    return await tool.execute("control-call", args.params, undefined, undefined, ctx);
  },
  device: async function (args) {
    const tool = tools.get(args.name);
    if (tool === undefined) throw new Error("no registered device " + args.name);
    return await tool.execute("device-call", args.params || {}, undefined, undefined, ctx);
  },
  read: async function (args) {
    try {
      return { value: await runtime.readArtifact(ctx, args.url) };
    } catch (error) {
      return { error: String(error && error.message ? error.message : error) };
    }
  },
  consequential: function (args) { return { value: runtime.consequential(args.toolName, args.input) }; },
  recordAction: function (args) {
    const state = runtime.stateFor(ctx);
    recordAction(state, { tool: args.tool, target: args.target, excerpt: args.excerpt }, args.bumps !== false);
    return { revision: state.revision };
  },
  setHold: async function (args) {
    const state = runtime.stateFor(ctx);
    state.hold = { id: args.id || "finding-test", boundary: "action", reason: args.reason || "an unresolved diagnostic finding", revision: state.revision, material: "{}", result: { kind: "unclear" } };
    await runtime.checkpoint(ctx, state, "test.hold");
    return { ok: true, findingId: state.hold.id };
  },
  bumpState: async function () {
    const state = runtime.stateFor(ctx);
    state.revision += 1;
    await runtime.checkpoint(ctx, state, "test.bump_state");
    return { ok: true, revision: state.revision };
  },
  setSession: function (args) {
    if (args.id !== undefined) sessionId = args.id;
    if (args.file !== undefined) sessionFile = args.file;
    if (args.artifacts !== undefined) artifactsDir = args.artifacts;
    return { ok: true };
  },
  setJudge: function (args) { judgeSpec = args; return { ok: true }; },
  judgeCalls: function () { return { count: judgeCalls.length }; },
};
const rl = createInterface({ input: process.stdin });
rl.on("line", async function (line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  try {
    const value = await commands[message.method](message.args || {});
    process.stdout.write(JSON.stringify({ id: message.id, ok: true, value: value }) + "\\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: message.id, ok: false, error: String(error && error.message ? error.message : error) }) + "\\n");
  }
});
`;
}

interface RuntimeEnv {
	base: string;
	root: string;
	artifacts: string;
	sessionFile: string;
	storeFile: string;
	store: AutonomyStore;
	runId: string;
	me: ProcessIdentity;
}

interface RuntimeHarness extends RuntimeEnv {
	proc: Subprocess<"pipe", "pipe", "pipe">;
	rpc: RuntimeRpc;
	logFile: string;
	launch: AutonomyScopeLaunch;
	scope: AutonomyScope;
	identity: ProcessIdentity;
	session: { id: string; file: string };
}

interface RuntimeRpc {
	send(method: string, args?: Record<string, unknown>): Promise<unknown>;
	close(error?: Error): void;
	stderr(): string;
}

function runtimePolicy(root: string, overrides: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
	return {
		roots: [root],
		effects: ["project"],
		maxJudgeCalls: 60,
		maxExecutorCalls: 10,
		maxRuntimeMs: 120_000,
		maxContextBytes: 200_000,
		maxArtifactBytes: 100_000,
		...overrides,
	};
}

function audienceFor(objective: string, external: boolean): {
	external: boolean;
	objectiveDigest: string;
	decisionId: string;
} {
	return { external, objectiveDigest: sha256(objective), decisionId: sha256(`initial lifecycle decision:${objective}`) };
}

function makeRuntimeEnv(
	objective: string,
	overrides: Partial<AutonomyPolicy> = {},
	external = false,
): RuntimeEnv {
	const base = freshDirectory("jev-autonomy-runtime-");
	const root = join(base, "project");
	mkdirSync(root);
	const artifacts = join(base, "artifacts");
	mkdirSync(join(artifacts, "local"), { recursive: true });
	const sessionFile = join(base, "sessions", "main.jsonl");
	mkdirSync(dirname(sessionFile), { recursive: true });
	const storeFile = join(base, "state", "autonomy.sqlite");
	const store = openAutonomyStore(storeFile);
	liveStores.push(store);
	const identity = me();
	const run = store.create(objective, runtimePolicy(root, overrides));
	const claimed = store.claim(run.id, identity);
	const audience = audienceFor(objective, external);
	store.update(
		run.id,
		{ epoch: claimed.epoch },
		next => {
			next.audience = audience;
			next.status = "running";
		},
		[
			{
				kind: "driver.recovery_decision",
				data: {
					decisionId: audience.decisionId,
					purpose: "initial lifecycle launch",
					contextDigest: sha256(`initial lifecycle context:${objective}`),
					context: { objective },
					questions: [{ name: "deliverable_audience", mode: "choice" }],
					outcome: { ok: true, answers: [] },
					at: Date.now(),
				},
			},
		],
	);
	return { base, root, artifacts, sessionFile, storeFile, store, runId: run.id, me: identity };
}

function runtimeOwnerUpdate(
	env: RuntimeEnv,
	mutate: (run: AutonomyRun) => void,
	events: Array<{ kind: string; data: unknown }> = [],
): AutonomyRun {
	const run = env.store.read(env.runId);
	return env.store.update(env.runId, { epoch: run.epoch }, mutate, events);
}

async function observeScopedProcess(
	launch: AutonomyScopeLaunch,
	proc: Subprocess<"pipe", "pipe", "pipe">,
): Promise<{ scope: AutonomyScope; identity: ProcessIdentity }> {
	const deadline = Date.now() + 15_000;
	let failure: unknown;
	for (;;) {
		try {
			const identity = processIdentity(proc.pid);
			if (identity === null) throw new Error(`the scoped process ${proc.pid} exited before its scope was observed`);
			return { scope: await observeAutonomyScope(launch, identity), identity };
		} catch (error) {
			failure = error;
			const message = error instanceof Error ? error.message : String(error);
			const starting =
				message === `scope ${launch.unit} is not loaded` || message === `scope ${launch.unit} is not active`;
			if (!starting || proc.exitCode !== null || Date.now() > deadline) break;
			await Bun.sleep(30);
		}
	}
	throw new Error(`cannot observe scope ${launch.unit}: ${failure instanceof Error ? failure.message : String(failure)}`);
}

function runtimeRpc(proc: Subprocess<"pipe", "pipe", "pipe">): RuntimeRpc {
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	let buffer = "";
	let stderr = "";
	const stdout = proc.stdout;
	const stdin = proc.stdin;
	if (stdout === undefined || typeof stdout === "number") throw new Error("the runtime stdout is not a pipe");
	if (stdin === undefined || typeof stdin === "number") throw new Error("the runtime stdin is not a pipe");
	const reader = stdout.getReader();
	void (async () => {
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done || value === undefined) break;
				buffer += decoder.decode(value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					if (line.trim().length === 0) continue;
					try {
						const message = JSON.parse(line) as { id?: number; ok?: boolean; value?: unknown; error?: string };
						if (typeof message.id !== "number") continue;
						const waiter = pending.get(message.id);
						if (waiter === undefined) continue;
						pending.delete(message.id);
						if (message.ok === true) waiter.resolve(message.value);
						else waiter.reject(new Error(message.error ?? "the runtime reported an unknown error"));
					} catch {
						// A malformed line is ignored; the call timeout names the failure.
					}
				}
			}
		} catch {
			// The runtime closed its output; pending calls time out with stderr below.
		}
	})();
	const errPipe = proc.stderr;
	if (errPipe !== undefined && typeof errPipe !== "number") {
		const errReader = errPipe.getReader();
		void (async () => {
			const decoder = new TextDecoder();
			try {
				for (;;) {
					const { done, value } = await errReader.read();
					if (done || value === undefined) break;
					stderr += decoder.decode(value, { stream: true });
				}
			} catch {
				// Diagnostics are best effort.
			}
		})();
	}
	let nextId = 0;
	return {
		async send(method, args = {}) {
			const id = nextId + 1;
			nextId = id;
			const response = Promise.withResolvers<unknown>();
			pending.set(id, { resolve: response.resolve, reject: response.reject });
			await stdin.write(JSON.stringify({ id, method, args }) + "\n");
			await stdin.flush();
			const timeout = Promise.withResolvers<never>();
			const timer = setTimeout(
				() => timeout.reject(new Error(`the runtime did not answer ${method}; stderr: ${stderr}`)),
				10_000,
			);
			// Bun's timer is a Node handle with unref; the DOM typings lose that member.
			const handle = timer as unknown as { unref?: () => void };
			handle.unref?.();
			return await Promise.race([response.promise, timeout.promise]);
		},
		close(error = new Error("the runtime channel closed")) {
			for (const waiter of pending.values()) waiter.reject(error);
			pending.clear();
			try {
				stdin.end();
			} catch {
				// The child may already be gone.
			}
		},
		stderr: () => stderr,
	};
}

async function spawnRuntime(env: RuntimeEnv): Promise<RuntimeHarness> {
	await checkAutonomyScopeCapability();
	const logFile = join(env.base, "messages.log");
	writeFileSync(logFile, "");
	env.store.claim(env.runId, env.me);
	const launch = makeAutonomyScopeLaunch(env.runId, env.store.read(env.runId).epoch);
	const proc = Bun.spawn(autonomyScopeCommand(launch, process.execPath, ["-e", runtimeChildSource()]), {
		cwd: env.root,
		env: {
			...process.env,
			JEV_TEST_STORE: env.storeFile,
			JEV_TEST_RUN: env.runId,
			JEV_TEST_SESSION: "session-1",
			JEV_TEST_SESSION_FILE: env.sessionFile,
			JEV_TEST_ARTIFACTS: env.artifacts,
			JEV_TEST_CWD: env.root,
			JEV_TEST_LOG: logFile,
			JEV_TEST_CONFIG: JSON.stringify(DEFAULT_CONFIG),
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});
	let identity: ProcessIdentity | undefined;
	let scope: AutonomyScope | undefined;
	runtimeCleanups.push(async () => {
		try {
			if (scope !== undefined) await fenceAutonomyScope(scope);
		} catch {
			try {
				if (identity !== undefined && processAlive(identity)) process.kill(identity.pid, "SIGKILL");
			} catch {
				// The observed identity already exited.
			}
		}
		await settle(proc.exited, 8_000);
		await awaitUnitGone(launch.unit);
	});
	const ready = await observeScopedProcess(launch, proc);
	identity = ready.identity;
	scope = ready.scope;
	if (identity.parent !== env.me.pid) throw new Error("the runtime child is not parented by the test supervisor");
	const epoch = env.store.read(env.runId).epoch;
	env.store.bindScope(env.runId, epoch, scope);
	env.store.bindChild(env.runId, epoch, identity);
	const session = { id: "session-1", file: env.sessionFile };
	env.store.bindSession(env.runId, epoch, session);
	const rpc = runtimeRpc(proc);
	return { ...env, proc, rpc, logFile, launch, scope, identity, session };
}

async function rebindSession(harness: RuntimeHarness, id: string): Promise<void> {
	const file = join(harness.base, "sessions", `${id}.jsonl`);
	harness.store.bindSession(harness.runId, harness.store.read(harness.runId).epoch, { id, file });
	await harness.rpc.send("setSession", { id, file });
}

function eventsOf(env: RuntimeEnv, kind: string): Array<{ sequence: number; kind: string; data: unknown }> {
	return env.store.events(env.runId).filter(event => event.kind === kind);
}

function valueOf(reply: unknown): Record<string, unknown> {
	const record = asRecord(reply);
	if (record === undefined) throw new Error(`the runtime returned no object: ${JSON.stringify(reply)}`);
	return record;
}

function outcomeOf(reply: unknown): Record<string, unknown> {
	return asRecord(valueOf(reply)["outcome"]) ?? {};
}

function attachWorkflow(env: RuntimeEnv, planText = "# Plan\n\n## Step one\nWrite out.txt and run the verification command."): { path: string; digest: string } {
	const run = env.store.read(env.runId);
	const task = run.checkpoint.task;
	if (task === undefined) throw new Error("the run has not bootstrapped a task");
	const path = join(env.artifacts, "local", "plan.md");
	writeFileSync(path, planText);
	const digest = sha256(planText);
	runtimeOwnerUpdate(env, next => {
		next.checkpoint.requirementsApproval = { taskFingerprint: task.fingerprint, items: ["r1"] };
		next.checkpoint.plan = { taskFingerprint: task.fingerprint, planUrl: "local://plan.md", planDigest: digest };
		next.checkpoint.planTopics = [{ id: "t1", section: planText, paths: [join(env.root, "out.txt")], requirement: "r1" }];
		next.manifest["local://plan.md"] = digest;
	});
	return { path, digest };
}

function attachActions(env: RuntimeEnv): void {
	const path = join(env.root, "out.txt");
	const content = "fixed payload";
	writeFileSync(path, content);
	const run = env.store.read(env.runId);
	env.store.update(
		env.runId,
		{ epoch: run.epoch },
		next => {
			next.checkpoint.actions = [
				{ tool: "write", target: path, excerpt: `wrote out.txt: ${content}` },
				{ tool: "bash", target: "bun test", excerpt: "1 pass, 0 fail" },
			];
			next.checkpoint.revision = 2;
			next.checkpoint.actionsSinceCheck = 0;
			next.manifest[path] = sha256(content);
		},
		[],
		{ [path]: new TextEncoder().encode(content) },
	);
}

const ACTION_QUESTIONS = [
	{
		name: "action",
		mode: "choice" as const,
		instructions: "May this exact proposedInvocation execute?",
		options: { on_course: "it serves the task", off_course: "it departs", unclear: "effects are unclear" },
	},
	{
		name: "within_authority",
		mode: "noul" as const,
		instructions: "Is the invocation within the frozen policy and roots?",
		trueMeaning: "yes",
		falseMeaning: "no",
	},
];

function actionMaterial(tool: string, target: string, input: Record<string, unknown>, callId: string): Record<string, unknown> {
	return {
		registeredTask: "the strict objective",
		proposedInvocation: { tool, target, change: JSON.stringify(input), callId },
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(20);
	}
	throw new Error("the expected state was not observed within the bound");
}

// ---------------------------------------------------------------------------
// Scenario 2: strict execution starts only through its explicit supervisor.
// ---------------------------------------------------------------------------

given("the owner runs the autonomy supervisor with an objective and policy", value => {
	const world = w(value);
	startLive(world, { child: "real" });
});

when("both run and store locators are valid", async value => {
	const world = w(value);
	const live = world.live;
	if (live === undefined) throw new Error("the supervisor was not started");
	const run = await waitForRun(
		live.storePath,
		candidate =>
			candidate.status === "running" &&
			candidate.child !== undefined &&
			candidate.scope !== undefined &&
			candidate.session !== undefined,
	);
	live.runId = run.id;
	expect(run.owner).toEqual(me());
	expect(run.id.length).toBeGreaterThan(0);
	expect(existsSync(live.storePath)).toBe(true);
	expect(run.child?.pid).toBeGreaterThan(0);
	expect(run.session?.id.length).toBeGreaterThan(0);
	// The locators were passed to the child, never inherited from this test process.
	expect(process.env["JEVSTICE_AUTONOMY_STORE"]).toBeUndefined();
	expect(process.env["JEVSTICE_AUTONOMY_RUN"]).toBeUndefined();
});

then("the supervised child loads the strict entry explicitly", value => {
	const world = w(value);
	const live = world.live;
	if (live === undefined || live.runId === undefined) throw new Error("no supervised run was observed");
	const store = liveStore(live);
	const run = store.read(live.runId);
	const scope = run.scope;
	const child = run.child;
	if (scope === undefined || child === undefined) throw new Error("the run has no observed scope or child");
	expect(scope.bootId).toBe(autonomyBootId());
	expect(scope.unit).toMatch(/^jevstice-.*\.scope$/);
	expect(scope.controlGroup.endsWith(`/${scope.unit}`)).toBe(true);
	expect(scope.invocationId).toMatch(/^[0-9a-f]{32}$/);
	expect(child.group).toBe(child.pid);
	expect(child.bootId).toBe(autonomyBootId());
	expect(processAlive(child)).toBe(true);

	// The live kernel argv is the actual launch, not the intent that was judged.
	const argv = readFileSync(`/proc/${child.pid}/cmdline`, "utf8").split("\0").filter(entry => entry.length > 0);
	const entryFlag = argv.indexOf("-e");
	expect(entryFlag).toBeGreaterThan(0);
	expect(argv[entryFlag + 1]).toBe(STRICT_ENTRY);
	expect(argv).toContain("--mode");
	expect(argv).toContain("rpc");
	expect(argv).toContain("--no-extensions");

	const events = store.events(run.id);
	const intent = events.find(event => event.kind === "driver.launch_intent");
	if (intent === undefined) throw new Error("the launch intent was not recorded");
	const data = asRecord(intent.data);
	expect(data?.["entry"]).toBe(STRICT_ENTRY);
	const command = data?.["command"];
	expect(Array.isArray(command)).toBe(true);
	if (!Array.isArray(command)) throw new Error("the launch intent has no command");
	expect(command.map(String)).toEqual(expect.arrayContaining(["-e", STRICT_ENTRY]));
	const restore = events.find(event => {
		if (event.kind !== "autonomy.restore") return false;
		return asRecord(event.data)?.["sessionId"] === run.session?.id;
	});
	expect(restore).toBeDefined();
	expect(events.some(event => event.kind === "driver.bootstrap_ack")).toBe(true);

	const rows = statusAutonomy({ store: live.storePath, run: run.id });
	expect(rows[0]).toMatchObject({
		id: run.id,
		status: "running",
		scopeUnit: scope.unit,
		scopeBootId: scope.bootId,
		childPid: child.pid,
	});
});

then("missing or invalid locators refuse the run rather than falling back", async value => {
	const world = w(value);
	const live = world.live;
	if (live === undefined || live.runId === undefined) throw new Error("no supervised run was observed");
	const store = liveStore(live);
	const beforeStop = store.read(live.runId);
	const child = beforeStop.child;
	const scope = beforeStop.scope;
	if (child === undefined || scope === undefined) throw new Error("the live run has no observed child or scope");
	const startedAt = Date.now();
	live.controller.abort("scenario observation complete");
	const result = await live.driving;
	const elapsed = Date.now() - startedAt;
	expect(result.status).toBe("cancelled");
	expect(result.exitCode).toBe(0);
	expect(elapsed).toBeLessThanOrEqual(120_000);
	await awaitUnitGone(scope.unit);
	expect(processIdentity(child.pid)).toBeNull();
	const after = store.read(live.runId);
	expect(after.status).toBe("cancelled");
	expect(after.fences.some(fence => fence.scope.unit === scope.unit)).toBe(true);

	const missingStore = join(live.dir, "missing-store.sqlite");
	const refusal = await startAutonomyRun({
		store: missingStore,
		objectiveFile: live.objectiveFile,
		policyFile: join(live.dir, "missing-policy.json"),
	}).then(
		() => undefined,
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
	expect(refusal).toBeDefined();
	expect(existsSync(missingStore)).toBe(false);
	expect(() => statusAutonomy({ store: missingStore })).toThrow(/does not exist/);

	for (const locators of [
		{ store: "", run: "" },
		{ store: live.storePath, run: "no-such-run" },
	] as const) {
		setTrackedEnv("JEVSTICE_AUTONOMY_STORE", locators.store);
		setTrackedEnv("JEVSTICE_AUTONOMY_RUN", locators.run);
		const pi = fakePi();
		await strictExtension({ ...pi.api, zod: fakeZod() });
		const results = await pi.emit(
			"tool_call",
			toolCallEvent("write", { path: join(live.root, "fallback.txt"), content: "x" }),
			fakeCtx(),
		);
		const reason = blockReason(results);
		expect(reason).toBeDefined();
		expect(reason).toMatch(/Strict autonomous initialization failed closed/);
		expect(reason).toMatch(locators.store === "" ? /Both nonempty/ : /no-such-run|does not exist|not found/i);
		expect(pi.tools.has("jev_autonomy")).toBe(false);
	}
	expect(existsSync(join(live.root, "fallback.txt"))).toBe(false);
});

// ---------------------------------------------------------------------------
// Scenario 8: operator stop closes admission without waiting for Jev.
// ---------------------------------------------------------------------------

given("a strict run is active", async value => {
	const world = w(value);
	const live = startLive(world);
	const run = await waitForRun(
		live.storePath,
		candidate =>
			candidate.status === "running" &&
			candidate.child !== undefined &&
			candidate.scope !== undefined &&
			candidate.session !== undefined,
	);
	live.runId = run.id;
	world.observed = { child: run.child!, scope: run.scope! };
	world.liveJudgeCalls = live.judgeCalls();
	expect(run.pending).toEqual({});
	expect(startCount(live)).toBe(1);
	expect(world.liveJudgeCalls).toBe(1);
});

when("the operator sends stop through the supervisor", async value => {
	const world = w(value);
	const live = world.live;
	if (live === undefined || live.runId === undefined) throw new Error("no active strict run");
	world.stopResult = await stopAutonomy({ store: live.storePath, run: live.runId, reason: "operator stop" });
	live.result = await live.driving;
	expect(live.result.status).toBe("cancelled");
});

then("admission closes immediately and queued wakeups are cancelled", value => {
	const world = w(value);
	const live = world.live;
	if (live === undefined || live.runId === undefined) throw new Error("no active strict run");
	const store = liveStore(live);
	const run = store.read(live.runId);
	const stopped = world.stopResult;
	if (stopped === undefined) throw new Error("the operator stop returned no result");
	expect(stopped.status).toBe("cancelled");
	expect(stopped.exitCode).toBe(0);
	expect(stopped.durableCancellation).toBe(true);
	expect(run.status).toBe("cancelled");
	expect(run.pending).toEqual({});
	expect(run.wake).toBeUndefined();
	expect(run.waiting).toBeUndefined();
	expect(() => store.claim(run.id, me())).toThrow(/terminal/);
	const events = store.events(run.id);
	const cancel = events.find(event => event.kind === "cancel");
	if (cancel === undefined) throw new Error("the cancellation was not committed");
	const lateWake = events.some(
		event =>
			event.sequence > cancel.sequence &&
			(event.kind === "wake.commit" || event.kind === "wake.send" || event.kind === "wake.start"),
	);
	expect(lateWake).toBe(false);
});

then("active work is aborted without a Jev call", async value => {
	const world = w(value);
	const live = world.live;
	const observed = world.observed;
	if (live === undefined || live.runId === undefined || observed === undefined) {
		throw new Error("no active strict run was observed");
	}
	expect(live.judgeCalls()).toBe(world.liveJudgeCalls ?? -1);
	await awaitUnitGone(observed.scope.unit);
	expect(processIdentity(observed.child.pid)).toBeNull();
	const store = liveStore(live);
	const run = store.read(live.runId);
	expect(run.fences.some(fence => fence.scope.unit === observed.scope.unit)).toBe(true);
	const events = store.events(run.id);
	const cancel = events.find(event => event.kind === "cancel");
	if (cancel === undefined) throw new Error("the cancellation was not committed");
	expect(
		events.some(event => event.sequence > cancel.sequence && event.kind === "driver.judge_attempt"),
	).toBe(false);
});

then("cancellation is acknowledged as durable only after its commit", value => {
	const world = w(value);
	const live = world.live;
	if (live === undefined || live.runId === undefined) throw new Error("no active strict run");
	const stopped = world.stopResult;
	if (stopped === undefined) throw new Error("the operator stop returned no result");
	const store = liveStore(live);
	const events = store.events(live.runId);
	const cancel = events.find(event => event.kind === "cancel");
	const fenced = events.find(event => event.kind === "scope-fenced");
	if (cancel === undefined || fenced === undefined) throw new Error("the stop did not commit both facts");
	expect(cancel.sequence).toBeLessThan(fenced.sequence);
	expect(stopped.durableCancellation).toBe(true);
	expect(stopped.status).toBe("cancelled");
	expect(store.read(live.runId).status).toBe("cancelled");
	expect(events.some(event => event.kind === "cancel" && asRecord(event.data)?.["reason"] === "operator stop")).toBe(true);
});

then("a failed commit still stops work and suppresses relaunch without claiming durability", async value => {
	const world = w(value);
	const live = startLive(world);
	const running = await waitForRun(
		live.storePath,
		candidate => candidate.status === "running" && candidate.child !== undefined && candidate.scope !== undefined,
	);
	live.runId = running.id;
	const child = running.child;
	const scope = running.scope;
	if (child === undefined || scope === undefined) throw new Error("the second run did not bind a scope");
	const store = liveStore(live);
	const trigger = new Database(live.storePath, { strict: true });
	try {
		trigger.exec("CREATE TRIGGER fail_runs_update BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'forced commit failure'); END;");
	} finally {
		trigger.close();
	}
	live.controller.abort("operator stop");
	const result = await live.driving;
	expect(result.exitCode).not.toBe(0);
	expect(result.durableCancellation ?? false).toBe(false);
	expect(result.status).not.toBe("cancelled");
	expect(result.message ?? "").toMatch(/not committed|forced commit failure/i);
	// Work stopped even though durability was never claimed.
	await awaitUnitGone(scope.unit);
	expect(processIdentity(child.pid)).toBeNull();
	const events = store.events(running.id);
	expect(events.filter(event => event.kind === "driver.launch_intent")).toHaveLength(1);
	expect(startCount(live)).toBe(1);
	expect(events.some(event => event.kind === "completed")).toBe(false);
	expect(store.read(running.id).status).toBe("running");
	const drop = new Database(live.storePath, { strict: true });
	try {
		drop.exec("DROP TRIGGER fail_runs_update");
	} finally {
		drop.close();
	}
	const committed = await stopAutonomy({ store: live.storePath, run: running.id, reason: "cleanup after failed commit" });
	expect(committed.durableCancellation).toBe(true);
	expect(committed.status).toBe("cancelled");
});

// ---------------------------------------------------------------------------
// Scenario 20: a rotation request is not a completed run.
// ---------------------------------------------------------------------------

given("a strict run requests session rotation", async value => {
	const world = w(value);
	const live = startLive(world);
	const run = await waitForRun(
		live.storePath,
		candidate =>
			candidate.status === "running" &&
			candidate.child !== undefined &&
			candidate.scope !== undefined &&
			candidate.session !== undefined,
	);
	live.runId = run.id;
	world.rotation = { runId: run.id, oldChild: run.child!, oldScope: run.scope! };
	const store = liveStore(live);
	store.update(
		run.id,
		{ epoch: run.epoch },
		next => {
			next.status = "waiting";
			next.waiting = { kind: "rotation_requested", reason: "the executor requested a fresh session generation", attempts: 0 };
		},
		[],
	);
	expect(store.read(run.id).status).toBe("waiting");
	expect(store.events(run.id).some(event => event.kind === "completed")).toBe(false);
});

when("the supervisor records the lifecycle transition", async value => {
	const world = w(value);
	const live = world.live;
	const rotation = world.rotation;
	if (live === undefined || rotation === undefined || live.runId === undefined) {
		throw new Error("no rotation request was recorded");
	}
	const store = liveStore(live);
	await waitFor(() => {
		const events = store.events(live.runId ?? "");
		const acks = events.filter(event => event.kind === "driver.bootstrap_ack").length;
		return acks >= 2 && events.some(event => event.kind === "driver.rotation");
	}, 12_000);
	const rotated = store.read(live.runId);
	expect(rotated.child).toBeDefined();
	expect(rotated.child?.pid).not.toBe(rotation.oldChild.pid);
	expect(processIdentity(rotated.child?.pid ?? -1)).not.toBeNull();
});

then("the run is not marked completed by the rotation request", value => {
	const world = w(value);
	const live = world.live;
	if (live === undefined || live.runId === undefined) throw new Error("no rotated run");
	const store = liveStore(live);
	const run = store.read(live.runId);
	expect(run.status).not.toBe("completed");
	expect(run.checkpoint.completion).toBeUndefined();
	expect(store.events(run.id).some(event => event.kind === "completed")).toBe(false);
});

then("the current scope is fenced before any replacement launch", async value => {
	const world = w(value);
	const live = world.live;
	const rotation = world.rotation;
	if (live === undefined || live.runId === undefined || rotation === undefined) throw new Error("no rotated run");
	const store = liveStore(live);
	const events = store.events(live.runId);
	const fenced = events.find(event => {
		if (event.kind !== "scope-fenced") return false;
		return asRecord(asRecord(event.data)?.["scope"])?.["unit"] === rotation.oldScope.unit;
	});
	const transition = events.find(event => event.kind === "driver.rotation");
	const launches = events.filter(event => event.kind === "driver.launch_intent");
	if (fenced === undefined || transition === undefined) throw new Error("the rotation was not fenced and recorded");
	expect(launches.length).toBeGreaterThanOrEqual(2);
	expect(fenced.sequence).toBeLessThan(transition.sequence);
	const replacement = launches[1];
	if (replacement === undefined) throw new Error("no replacement launch was recorded");
	expect(transition.sequence).toBeLessThan(replacement.sequence);
	const replacementLaunch = asRecord(asRecord(replacement.data)?.["launch"]);
	expect(replacementLaunch?.["unit"]).not.toBe(rotation.oldScope.unit);
	await awaitUnitGone(rotation.oldScope.unit);
	const run = store.read(live.runId);
	expect(run.fences.some(fence => fence.scope.unit === rotation.oldScope.unit)).toBe(true);
});

then("a replacement requires its own committed decision", async value => {
	const world = w(value);
	const live = world.live;
	const rotation = world.rotation;
	if (live === undefined || live.runId === undefined || rotation === undefined) throw new Error("no rotated run");
	const store = liveStore(live);
	const events = store.events(live.runId);
	const decisions = events.filter(event => event.kind === "driver.recovery_decision");
	expect(decisions.length).toBeGreaterThanOrEqual(2);
	const transition = events.find(event => event.kind === "driver.rotation");
	if (transition === undefined) throw new Error("no rotation transition was recorded");
	const replacementDecision = decisions.find(event => event.sequence > transition.sequence);
	expect(replacementDecision).toBeDefined();
	const launches = events.filter(event => event.kind === "driver.launch_intent");
	expect(launches).toHaveLength(2);
	expect(startCount(live)).toBe(2);
	expect(processIdentity(rotation.oldChild.pid)).toBeNull();
	const stopped = await stopAutonomy({ store: live.storePath, run: live.runId, reason: "rotation observed" });
	expect(stopped.status).toBe("cancelled");
	expect(stopped.exitCode).toBe(0);
	const result = await live.driving;
	expect(result.status).toBe("cancelled");
});

// ---------------------------------------------------------------------------
// Scenario 6: Jev verdicts do not decide strict admission.
// ---------------------------------------------------------------------------

given("a strict invocation is deterministically safe within the envelope", async value => {
	const world = w(value);
	const env = makeRuntimeEnv("Write a small safe note in the project.");
	const harness = await spawnRuntime(env);
	world.runtime = harness;
	world.runId = env.runId;
	world.input = { path: join(env.root, "safe.txt"), content: "safe" };
	world.callId = "call-06";
	await harness.rpc.send("state");
	expect(valueOf(await harness.rpc.send("consequential", { toolName: "write", input: world.input }))["value"]).toBe(true);
	expect(env.store.read(env.runId).pending).toEqual({});
	expect(env.store.read(env.runId).checkpoint.hold).toBeUndefined();
});

when("its Jev diagnostic is negative, unavailable or below the floor", async value => {
	const world = w(value);
	const harness = world.runtime;
	const input = world.input;
	const callId = world.callId;
	if (harness === undefined || input === undefined || callId === undefined) throw new Error("no safe invocation");
	await harness.rpc.send("setJudge", {
		answers: {
			action: { label: "off_course", confidence: 0.99 },
			within_authority: { probability: 0.01, confidence: 0.99 },
		},
	});
	world.judged = valueOf(
		await harness.rpc.send("judge", {
			material: actionMaterial("write", String(input.path), input, callId),
			questions: ACTION_QUESTIONS,
		}),
	);
	expect(outcomeOf(world.judged)["ok"]).toBe(true);
	const admitted = valueOf(
		await harness.rpc.send("admit", {
			event: { type: "tool_call", toolCallId: callId, toolName: "write", input },
		}),
	);
	expect(admitted["ok"]).toBe(true);
});

then("the result remains recorded as that diagnostic", value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined || world.callId === undefined) throw new Error("no admitted invocation");
	const payload = asRecord(harness.store.read(harness.runId).pending[world.callId]?.payload);
	const diagnostic = asRecord(payload?.["diagnosticDecision"]);
	expect(diagnostic).toBeDefined();
	expect(diagnostic?.["accepted"]).toBe(false);
	expect(diagnostic?.["action"]).toBe("off_course");
	expect(Number(diagnostic?.["withinAuthority"])).toBeLessThan(0.7);
	expect(eventsOf(harness, "judge.result")).toHaveLength(1);
	world.response = payload;
});

then("it does not by itself block admission, reconciliation, rotation or completion", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined || world.callId === undefined) throw new Error("no admitted invocation");
	const run = harness.store.read(harness.runId);
	expect(run.pending[world.callId]).toBeDefined();
	expect(run.checkpoint.hold).toBeUndefined();
	expect(run.waiting).toBeUndefined();
	const rotated = valueOf(
		await harness.rpc.send("control", {
			params: { action: "rotate", reason: "the diagnostic must not block rotation" },
		}),
	);
	expect(rotated["isError"]).toBe(false);
	expect(harness.store.read(harness.runId).waiting?.kind).toBe("rotation_requested");
	// The observed effect is settled, then ending the turn is not blocked by the diagnostic;
	// rotation owns the terminal transition and completion is covered by scenario 13.
	const input = world.input;
	if (input === undefined || world.callId === undefined) throw new Error("no admitted invocation");
	await harness.rpc.send("result", {
		event: {
			type: "tool_result",
			toolCallId: world.callId,
			toolName: "write",
			input,
			content: [{ type: "text", text: "wrote safe.txt" }],
			isError: false,
		},
	});
	expect(harness.store.read(harness.runId).pending).toEqual({});
	const stopped = valueOf(await harness.rpc.send("stop"));
	expect(stopped["decision"]).toBeNull();
});

then("it does not authorize an effect either", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	// A diagnostic that approved nothing still cannot authorize an ungranted publication effect,
	// and the admitted effect above was authorized by the frozen policy, not by the verdict.
	const payload = asRecord(world.response);
	expect(asRecord(payload?.["diagnosticDecision"])?.["accepted"]).toBe(false);
	expect(harness.store.read(harness.runId).policy.effects).toEqual(["project"]);
	const admitted = eventsOf(harness, "intent.admit");
	expect(admitted).toHaveLength(1);
	expect(asRecord(admitted[0]?.data)?.["id"]).toBe("call-06");
	const publication = valueOf(
		await harness.rpc.send("before", {
			event: {
				type: "tool_call",
				toolCallId: "publication-06",
				toolName: "write",
				input: { path: "xd://jev_unknown", content: "{}" },
			},
		}),
	);
	expect(publication["block"]).toBe(true);
	expect(publication["boundary"]).toBe("capability");
});

// ---------------------------------------------------------------------------
// Scenario 7: a stale diagnostic cannot describe current strict work.
// ---------------------------------------------------------------------------

given("a diagnostic is bound to an earlier run, revision, policy or artifact bytes", async value => {
	const world = w(value);
	const env = makeRuntimeEnv("Write a diagnostic-bound note in the project.");
	const harness = await spawnRuntime(env);
	world.runtime = harness;
	world.runId = env.runId;
	world.input = { path: join(env.root, "a.txt"), content: "hello" };
	world.callId = "call-07";
	await harness.rpc.send("state");
	world.judged = valueOf(
		await harness.rpc.send("judge", {
			material: actionMaterial("write", String(world.input.path), world.input, world.callId),
			questions: ACTION_QUESTIONS,
		}),
	);
	expect(outcomeOf(world.judged)["ok"]).toBe(true);
	world.revision = harness.store.read(harness.runId).checkpoint.revision;
});

when("the current work differs", async value => {
	const world = w(value);
	const harness = world.runtime;
	const input = world.input;
	const callId = world.callId;
	if (harness === undefined || input === undefined || callId === undefined) throw new Error("no judged invocation");
	const moved = valueOf(await harness.rpc.send("recordAction", { tool: "bash", target: "echo ok", excerpt: "ok" }));
	expect(moved["revision"]).toBe((world.revision ?? 0) + 1);
	const admitted = valueOf(
		await harness.rpc.send("admit", {
			event: { type: "tool_call", toolCallId: callId, toolName: "write", input },
		}),
	);
	expect(admitted["ok"]).toBe(true);
});

then("the answer is recorded as stale", value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	const stale = eventsOf(harness, "admission.decision_stale");
	expect(stale).toHaveLength(1);
	const data = asRecord(stale[0]?.data);
	expect(data?.["callId"]).toBe("call-07");
	expect(String(data?.["reason"])).toMatch(/no longer describes this exact call|revision|session/);
});

then("it is not attached as evidence for the current decision", value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined || world.callId === undefined) throw new Error("no admitted invocation");
	const payload = asRecord(harness.store.read(harness.runId).pending[world.callId]?.payload);
	expect(payload?.["diagnosticDecision"]).toBeUndefined();
	// The original answer is still a diagnostic record; it simply no longer describes this call.
	expect(eventsOf(harness, "judge.result")).toHaveLength(1);
});

then("it changes no admission state", value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined || world.callId === undefined) throw new Error("no admitted invocation");
	const run = harness.store.read(harness.runId);
	expect(run.pending[world.callId]).toBeDefined();
	expect(run.status).toBe("running");
	expect(run.checkpoint.hold).toBeUndefined();
	expect(run.waiting).toBeUndefined();
	expect(run.judgeCalls).toBe(1);
});

// ---------------------------------------------------------------------------
// Scenario 10: an intent without a result is unknown, not failed.
// ---------------------------------------------------------------------------

given("a committed invocation has no recorded terminal result", async value => {
	const world = w(value);
	const env = makeRuntimeEnv("Write the observed output in the project.");
	const harness = await spawnRuntime(env);
	world.runtime = harness;
	world.runId = env.runId;
	world.callId = "call-10";
	world.input = { path: join(env.root, "out.txt"), content: "observed output" };
	const callId = world.callId;
	await harness.rpc.send("state");
	await harness.rpc.send("judge", {
		material: actionMaterial("write", String(world.input.path), world.input, callId),
		questions: ACTION_QUESTIONS,
	});
	const admitted = valueOf(
		await harness.rpc.send("admit", {
			event: { type: "tool_call", toolCallId: callId, toolName: "write", input: world.input },
		}),
	);
	expect(admitted["ok"]).toBe(true);
	// No native result is recorded: the committed effect is unobserved when the run is recovered.
	expect(env.store.read(env.runId).pending[callId]).toBeDefined();
	expect(env.store.read(env.runId).checkpoint.completion).toBeUndefined();
});

when("the run is recovered", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime to recover");
	const env: RuntimeEnv = harness;
	await harness.rpc.send("state");
	const epoch = env.store.read(env.runId).epoch;
	await fenceAutonomyScope(harness.scope);
	await settle(harness.proc.exited, 8_000);
	await awaitUnitGone(harness.scope.unit);
	env.store.recordFence(env.runId, epoch, harness.scope);
	const recovered = await spawnRuntime(env);
	world.recovered = recovered;
	expect(recovered.identity.pid).not.toBe(harness.identity.pid);
	expect(recovered.scope.unit).not.toBe(harness.scope.unit);
	expect(recovered.store.read(env.runId).fences.some(fence => fence.scope.unit === harness.scope.unit)).toBe(true);
});

then("the intent is treated as unknown", value => {
	const world = w(value);
	const harness = world.recovered;
	if (harness === undefined || world.callId === undefined) throw new Error("the run was not recovered");
	const run = harness.store.read(harness.runId);
	const intent = run.pending[world.callId];
	if (intent === undefined) throw new Error("the recovered run dropped the unobserved intent");
	const payload = asRecord(intent.payload);
	expect(payload?.["unknown"]).not.toBe(false);
	expect(run.status).not.toBe("completed");
	expect(run.checkpoint.completion).toBeUndefined();
	expect(eventsOf(harness, "result.recorded").some(event => asRecord(event.data)?.["toolCallId"] === world.callId)).toBe(false);
});

then("observable state is inspected before any retry", async value => {
	const world = w(value);
	const harness = world.recovered;
	if (harness === undefined || world.callId === undefined || world.input === undefined) {
		throw new Error("the run was not recovered");
	}
	const path = String(world.input.path);
	const blanket = valueOf(
		await harness.rpc.send("control", {
			params: { action: "reconcile", intent: world.callId, observed: "executed" },
		}),
	);
	expect(blanket["isError"]).toBe(true);
	expect(JSON.stringify(blanket["content"])).toMatch(/evidence/);
	writeFileSync(path, "observed output");
	const reconciled = valueOf(
		await harness.rpc.send("control", {
			params: {
				action: "reconcile",
				intent: world.callId,
				observed: "executed",
				evidence: "a fresh read of out.txt shows the exact observed output bytes",
				observations: [path],
			},
		}),
	);
	expect(reconciled["isError"]).toBe(false);
	const run = harness.store.read(harness.runId);
	expect(run.pending[world.callId]).toBeUndefined();
	const reconciledEvents = eventsOf(harness, "reconcile");
	expect(reconciledEvents).toHaveLength(1);
	expect(asRecord(reconciledEvents[0]?.data)?.["outcome"]).toBe("executed");
	expect(asRecord(asRecord(reconciledEvents[0]?.data)?.["judgment"])?.["kind"]).toBe("judged");
	// The declared settlement carries the inspected path in the retained action evidence.
	expect(run.checkpoint.actions.at(-1)?.excerpt).toContain("fresh read of out.txt");
});

then("a retry occurs only when observed state or provider idempotency proves it safe", async value => {
	const world = w(value);
	const harness = world.recovered;
	if (harness === undefined) throw new Error("the run was not recovered");
	const retry = { path: join(harness.root, "retry.txt"), content: "retry" };
	expect(
		await harness.rpc.send("before", {
			event: { type: "tool_call", toolCallId: "retry-10", toolName: "write", input: retry },
		}),
	).toBeNull();
	const admitted = valueOf(
		await harness.rpc.send("admit", {
			event: { type: "tool_call", toolCallId: "retry-10", toolName: "write", input: retry },
		}),
	);
	expect(admitted["ok"]).toBe(true);
	await harness.rpc.send("result", {
		event: {
			type: "tool_result",
			toolCallId: "retry-10",
			toolName: "write",
			input: retry,
			content: [{ type: "text", text: "wrote retry.txt" }],
			isError: false,
		},
	});
	expect(harness.store.read(harness.runId).pending).toEqual({});
});

then("an irreconcilable effect remains a deterministic safety wait", async value => {
	const world = w(value);
	const harness = world.recovered;
	if (harness === undefined) throw new Error("the run was not recovered");
	const orphanId = "call-orphan";
	const orphanInput = { path: join(harness.root, "orphan.txt"), content: "orphan" };
	runtimeOwnerUpdate(harness, next => {
		next.pending[orphanId] = {
			id: orphanId,
			kind: "tool",
			payload: {
				tool: "write",
				target: orphanInput.path,
				callId: orphanId,
				invocation: JSON.stringify(orphanInput),
				invocationDigest: sha256(JSON.stringify(orphanInput)),
				scope: { ...harness.scope, unit: `${harness.scope.unit.replace(/\.scope$/, "")}-other.scope` },
				epoch: 0,
				generation: 0,
				sessionId: "old-session",
			},
			revision: 1,
			createdAt: Date.now(),
		};
	});
	const refused = valueOf(
		await harness.rpc.send("control", {
			params: {
				action: "reconcile",
				intent: orphanId,
				observed: "executed",
				evidence: "the exact old scope was never fenced for this intent",
			},
		}),
	);
	expect(refused["isError"]).toBe(true);
	expect(JSON.stringify(refused["content"])).toMatch(/no durable whole-scope fence receipt/);
	expect(harness.store.read(harness.runId).pending[orphanId]).toBeDefined();
	const blocked = valueOf(
		await harness.rpc.send("before", {
			event: {
				type: "tool_call",
				toolCallId: "after-orphan",
				toolName: "write",
				input: { path: join(harness.root, "after.txt"), content: "x" },
			},
		}),
	);
	expect(blocked["block"]).toBe(true);
	expect(blocked["boundary"]).toBe("reconcile");
});

// ---------------------------------------------------------------------------
// Scenario 11: restart restores records but not stale permission.
// ---------------------------------------------------------------------------

given("a run was checkpointed with accepted requirements and plan details", async value => {
	const world = w(value);
	const env = makeRuntimeEnv("Build the fixed output and verify it with a command.");
	const harness = await spawnRuntime(env);
	world.runtime = harness;
	world.runId = env.runId;
	await harness.rpc.send("state");
	attachWorkflow(env);
	await rebindSession(harness, "session-2");
	attachActions(env);
	const restoredState = valueOf(await harness.rpc.send("state"));
	expect(restoredState["requirements"]).toEqual(["r1"]);
	expect(env.store.read(env.runId).checkpoint.actions.length).toBeGreaterThan(0);
	for (const aspect of ["business", "architecture"] as const) {
		const accepted = valueOf(
			await harness.rpc.send("activity", {
				name: "acceptance",
				params: {
					aspect,
					claim: "The fixed output was implemented and verified.",
					evidence: [
						{ kind: "code", quote: "out.txt contains fixed payload" },
						{ kind: "execution", quote: "bun test: 1 pass, 0 fail" },
					],
				},
			}),
		);
		expect(asRecord(accepted["details"])?.["approved"]).toBe(true);
	}
	const run = env.store.read(env.runId);
	world.revision = run.checkpoint.revision;
	expect(run.checkpoint.requirementsApproval?.items).toEqual(["r1"]);
	expect(run.checkpoint.plan?.planUrl).toBe("local://plan.md");
});

when("a replacement session resumes the run", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	await rebindSession(harness, "session-3");
	world.response = valueOf(await harness.rpc.send("state"));
});

then("the committed record and unchanged decisions are restored", value => {
	const world = w(value);
	const state = asRecord(world.response);
	const harness = world.runtime;
	if (state === undefined || harness === undefined) throw new Error("the replacement session returned no state");
	expect(state["requirements"]).toEqual(["r1"]);
	expect(asRecord(state["plan"])?.["planUrl"]).toBe("local://plan.md");
	// Requirements and plan decisions are durable records. Execution acceptance is session-bound
	// permission, so the replacement session does not inherit it.
	const acceptance = Array.isArray(state["acceptance"]) ? state["acceptance"] : [];
	const approved = acceptance.filter(entry => asRecord(entry)?.["approved"] === true);
	expect(approved).toEqual([]);
	expect(eventsOf(harness, "bind_session").length).toBeGreaterThan(0);
});

then("changed dependencies invalidate only the affected acceptance and completion", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	const path = join(harness.root, "out.txt");
	writeFileSync(path, "changed after acceptance");
	const checkpointed = valueOf(await harness.rpc.send("checkpoint", { reason: "agent_end" }));
	expect(checkpointed["ok"]).toBe(true);
	const run = harness.store.read(harness.runId);
	expect(run.checkpoint.revision).toBe((world.revision ?? 0) + 1);
	expect(run.checkpoint.acceptance.filter(record => record.revision === run.checkpoint.revision)).toEqual([]);
	expect(run.checkpoint.completion).toBeUndefined();
	expect(run.checkpoint.requirementsApproval?.items).toEqual(["r1"]);
	expect(run.checkpoint.plan?.planUrl).toBe("local://plan.md");
	expect(eventsOf(harness, "manifest.changed").length).toBeGreaterThan(0);
});

then("prior execution acceptance requires fresh observation", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	const stale = valueOf(
		await harness.rpc.send("activity", {
			name: "acceptance",
			params: {
				aspect: "business",
				claim: "The earlier session already verified the output.",
				evidence: [
					{ kind: "execution", quote: "The previous session ran bun test: 1 pass, 0 fail." },
					{ kind: "code", quote: "The previous session wrote the fixed output." },
				],
			},
		}),
	);
	expect(asRecord(stale["details"])?.["approved"]).not.toBe(true);
	const run = harness.store.read(harness.runId);
	expect(run.checkpoint.acceptance.filter(record => record.approved && record.revision === run.checkpoint.revision)).toEqual([]);
});

then("a fork or summary does not independently inherit ownership", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	const before = harness.store.read(harness.runId);
	const script = `
import { openAutonomyStore, processIdentity } from ${JSON.stringify(STORE_MODULE)};
const store = openAutonomyStore(${JSON.stringify(harness.storeFile)});
const me = processIdentity();
if (me === null) { console.log("error:no identity"); process.exit(0); }
try {
  store.claim(${JSON.stringify(harness.runId)}, me);
  console.log("claimed");
} catch (error) {
  console.log("error:" + String(error && error.message ? error.message : error));
} finally {
  store.close();
}
`;
	const child = Bun.spawn([process.execPath, "-e", script], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	expect(code).toBe(0);
	world.forkError = output.trim();
	expect(world.forkError).toMatch(/another live supervisor owns this run/);
	const after = harness.store.read(harness.runId);
	expect(after.owner).toEqual(before.owner);
	expect(after.epoch).toBe(before.epoch);
	expect(after.checkpoint.requirementsApproval?.items).toEqual(["r1"]);
});

// ---------------------------------------------------------------------------
// Scenario 12: diagnostic retry budgets skip judgment only.
// ---------------------------------------------------------------------------

given("the judge budget or retry deadline is exhausted", async value => {
	const world = w(value);
	const env = makeRuntimeEnv("Write a bounded note with an exhausted judge budget.");
	const harness = await spawnRuntime(env);
	world.runtime = harness;
	world.runId = env.runId;
	world.callId = "call-12";
	world.input = { path: join(env.root, "bounded.txt"), content: "bounded" };
	await harness.rpc.send("state");
	const run = env.store.read(env.runId);
	runtimeOwnerUpdate(env, next => {
		next.judgeCalls = next.policy.maxJudgeCalls;
		next.checkpoint.exhausted = ["action"];
	});
	world.judgeCalls = run.policy.maxJudgeCalls;
	expect(env.store.read(env.runId).judgeCalls).toBe(run.policy.maxJudgeCalls);
});

when("a strict lifecycle diagnostic is due", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined || world.input === undefined || world.callId === undefined) {
		throw new Error("no bound runtime");
	}
	await harness.rpc.send("setJudge", { fail: "the judge must not be called when its budget is exhausted" });
	world.judged = valueOf(
		await harness.rpc.send("judge", {
			material: actionMaterial("write", String(world.input.path), world.input, world.callId),
			questions: ACTION_QUESTIONS,
		}),
	);
});

then("that diagnostic request is skipped and recorded as such", value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	const outcome = outcomeOf(world.judged);
	expect(outcome["ok"]).toBe(false);
	expect(String(outcome["problem"])).toMatch(/judge call budget is exhausted/);
	const run = harness.store.read(harness.runId);
	expect(run.judgeCalls).toBe(world.judgeCalls ?? -1);
	expect(eventsOf(harness, "judge.request")).toEqual([]);
	const resource = eventsOf(harness, "resource");
	expect(resource.some(event => asRecord(event.data)?.["kind"] === "judge_calls")).toBe(true);
	expect(run.waiting?.kind).toBe("resource");
});

then("actual executive progress follows deterministic safety facts", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined || world.input === undefined || world.callId === undefined) {
		throw new Error("no bound runtime");
	}
	const admitted = valueOf(
		await harness.rpc.send("admit", {
			event: { type: "tool_call", toolCallId: world.callId, toolName: "write", input: world.input },
		}),
	);
	expect(admitted["ok"]).toBe(true);
	const payload = asRecord(harness.store.read(harness.runId).pending[world.callId]?.payload);
	expect(payload?.["diagnosticDecision"]).toBeUndefined();
	await harness.rpc.send("result", {
		event: {
			type: "tool_result",
			toolCallId: world.callId,
			toolName: "write",
			input: world.input,
			content: [{ type: "text", text: "wrote bounded.txt" }],
			isError: false,
		},
	});
	expect(harness.store.read(harness.runId).pending).toEqual({});
});

then("an unchanged refused artifact does not become approved by repetition", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined || world.input === undefined) throw new Error("no bound runtime");
	const before = harness.store.read(harness.runId).judgeCalls;
	const first = valueOf(
		await harness.rpc.send("judge", {
			material: actionMaterial("write", String(world.input.path), world.input, "call-12-repeat"),
			questions: ACTION_QUESTIONS,
		}),
	);
	const second = valueOf(
		await harness.rpc.send("judge", {
			material: actionMaterial("write", String(world.input.path), world.input, "call-12-repeat"),
			questions: ACTION_QUESTIONS,
		}),
	);
	expect(outcomeOf(first)["ok"]).toBe(false);
	expect(outcomeOf(second)["ok"]).toBe(false);
	expect(harness.store.read(harness.runId).judgeCalls).toBe(before);
	expect(eventsOf(harness, "judge.result")).toEqual([]);
	expect(eventsOf(harness, "judge.request")).toEqual([]);
	expect(harness.store.read(harness.runId).pending["call-12-repeat"]).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Scenario 13: strict completion records evidence and discloses gaps.
// ---------------------------------------------------------------------------

given("observed execution and captured code evidence for the current revision", async value => {
	const world = w(value);
	const env = makeRuntimeEnv("Build the fixed output, verify it and disclose every gap.", {}, true);
	const harness = await spawnRuntime(env);
	world.runtime = harness;
	world.runId = env.runId;
	await harness.rpc.send("state");
	attachWorkflow(env);
	await rebindSession(harness, "session-2");
	attachActions(env);
	await harness.rpc.send("state");
	await harness.rpc.send("setJudge", {
		answers: { acceptance: { label: "does_not_serve_business_need", confidence: 0.99 } },
	});
	const failed = valueOf(
		await harness.rpc.send("activity", {
			name: "acceptance",
			params: {
				aspect: "business",
				claim: "The output is complete.",
				evidence: [
					{ kind: "code", quote: "out.txt contains fixed payload" },
					{ kind: "execution", quote: "bun test: 1 pass, 0 fail" },
				],
			},
		}),
	);
	expect(asRecord(failed["details"])?.["approved"]).not.toBe(true);
	world.judgeCalls = harness.store.read(env.runId).judgeCalls;
	const run = env.store.read(env.runId);
	expect(run.checkpoint.actions.length).toBeGreaterThan(0);
	expect(run.checkpoint.revision).toBeGreaterThan(0);
});

when("the run reaches a terminal stop", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	world.judgeCalls = harness.store.read(harness.runId).judgeCalls;
	world.judged = valueOf(await harness.rpc.send("stop"));
});

then("the run can commit completion without a Jev approval", value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	expect(asRecord(world.judged)?.["decision"]).toBeNull();
	const run = harness.store.read(harness.runId);
	expect(run.status).toBe("completed");
	expect(run.judgeCalls).toBe(world.judgeCalls ?? -1);
	expect(eventsOf(harness, "completed")).toHaveLength(1);
});

then("missing or failed acceptance and review evidence is recorded", value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	const completed = eventsOf(harness, "completed");
	const diagnostics = asRecord(asRecord(completed[0]?.data)?.["diagnostics"]);
	if (diagnostics === undefined) throw new Error("the completion event carries no diagnostics");
	const acceptance = asRecord(diagnostics["acceptance"]);
	const business = asRecord(acceptance?.["business"]);
	expect(business?.["approved"]).not.toBe(true);
	const review = asRecord(diagnostics["review"]);
	expect(review).toBeDefined();
	expect(review?.["complete"]).toBe(false);
	expect(Array.isArray(review?.["missing"])).toBe(true);
	expect(Array.isArray(review?.["blockers"])).toBe(true);
});

then("terminal completion is not presented as a claim that those checks passed", value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	const completed = eventsOf(harness, "completed");
	const diagnostics = asRecord(asRecord(completed[0]?.data)?.["diagnostics"]);
	if (diagnostics === undefined) throw new Error("the completion event carries no diagnostics");
	expect(String(diagnostics["note"])).toMatch(/not completion acceptance/);
	expect(asRecord(diagnostics["acceptance"])?.["architecture"]).toBeNull();
	expect(asRecord(diagnostics["review"])?.["complete"]).toBe(false);
	expect(harness.store.read(harness.runId).status).toBe("completed");
});

// ---------------------------------------------------------------------------
// Scenario 16: context and course diagnostics remain callable in a strict run.
// ---------------------------------------------------------------------------

given("a bound strict run with an approved plan", async value => {
	const world = w(value);
	const env = makeRuntimeEnv("Build the fixed output inside the approved plan.");
	const harness = await spawnRuntime(env);
	world.runtime = harness;
	world.runId = env.runId;
	await harness.rpc.send("state");
	attachWorkflow(env);
	await rebindSession(harness, "session-2");
	const state = valueOf(await harness.rpc.send("state"));
	expect(state["requirements"]).toEqual(["r1"]);
	expect(asRecord(state["plan"])?.["planUrl"]).toBe("local://plan.md");
	world.response = state;
});

when("the executor calls jev_context or jev_course_check", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	const contextRoute = await harness.rpc.send("before", {
		event: {
			type: "tool_call",
			toolCallId: "context-route",
			toolName: "write",
			input: { path: "xd://jev_context", content: JSON.stringify({ action: "list" }) },
		},
	});
	const courseRoute = await harness.rpc.send("before", {
		event: {
			type: "tool_call",
			toolCallId: "course-route",
			toolName: "write",
			input: { path: "xd://jev_course_check", content: JSON.stringify({ claim: "the work follows the plan" }) },
		},
	});
	expect(contextRoute).toBeNull();
	expect(courseRoute).toBeNull();
	await harness.rpc.send("setJudge", { answers: { course: { label: "on_course", confidence: 0.95 } } });
});

then("the call is treated as a safe diagnostic device", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	const context = valueOf(
		await harness.rpc.send("consequential", { toolName: "write", input: { path: "xd://jev_context" } }),
	);
	expect(context["value"]).toBe(false);
	const course = valueOf(
		await harness.rpc.send("consequential", { toolName: "write", input: { path: "xd://jev_course_check" } }),
	);
	expect(course["value"]).toBe(false);
	const unknown = valueOf(
		await harness.rpc.send("consequential", { toolName: "write", input: { path: "xd://jev_unknown" } }),
	);
	expect(unknown["value"]).toBe(true);
});

then("it does not create a project effect", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	const before = harness.store.read(harness.runId);
	const answer = valueOf(
		await harness.rpc.send("device", { name: "jev_context", params: { action: "list" } }),
	);
	world.response = answer;
	expect(Array.isArray(answer["content"])).toBe(true);
	const after = harness.store.read(harness.runId);
	expect(after.pending).toEqual({});
	// The device answer is observation only: no project file is created, and any new tracked
	// entry is the explicit absence marker for a planned path, never observed effect bytes.
	expect(readdirSync(harness.root)).toEqual([]);
	expect(after.artifacts).toEqual(before.artifacts);
	expect(Object.keys(after.manifest).filter(key => after.manifest[key] !== "absent")).toEqual(
		Object.keys(before.manifest).filter(key => before.manifest[key] !== "absent"),
	);
});

then("its answer is bound to the current run and revision", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	const context = valueOf(world.response);
	const details = asRecord(context["details"]);
	const afterContext = harness.store.read(harness.runId);
	expect(details?.["revision"]).toBe(afterContext.checkpoint.revision);
	const content = Array.isArray(context["content"]) ? context["content"] : [];
	expect(JSON.stringify(content)).toContain("Current objective");
	const course = valueOf(
		await harness.rpc.send("device", {
			name: "jev_course_check",
			params: { claim: "the work follows the approved plan" },
		}),
	);
	const courseDetails = asRecord(course["details"]);
	expect(courseDetails?.["revision"]).toBe(harness.store.read(harness.runId).checkpoint.revision);
	expect(courseDetails?.["approved"]).toBe(true);
	expect(harness.store.read(harness.runId).pending).toEqual({});
});

// ---------------------------------------------------------------------------
// Scenario 17: publication uses only authorized, reviewed bytes.
// ---------------------------------------------------------------------------

given("the committed policy authorizes the publication effect class", async value => {
	const world = w(value);
	const env = makeRuntimeEnv(
		"Deliver the exact reviewed result to the external audience.",
		{ effects: ["project", "publication"] },
		true,
	);
	world.runId = env.runId;
	world.runtime = await spawnRuntime(env);
});

given("the exact artifact bytes have a current review", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no runtime was started");
	await harness.rpc.send("state");
	const artifact = "The reviewed result.";
	const record = {
		taskFingerprint: harness.store.read(harness.runId).checkpoint.task?.fingerprint,
		request: harness.store.read(harness.runId).objective,
		revision: 0,
		part: { index: 1, total: 1 },
		partDigest: sha256(artifact),
		artifact,
		language: "en",
		register: "formal",
		rulesDigest: "rules",
		findings: [],
	};
	runtimeOwnerUpdate(harness, next => {
		next.checkpoint.antiSlopReviews = [record];
	});
	await rebindSession(harness, "session-2");
	await harness.rpc.send("state");
	world.response = { harness, artifact, record };
	const run = harness.store.read(harness.runId);
	expect(run.policy.effects).toEqual(["project", "publication"]);
	expect(run.checkpoint.antiSlopReviews?.[0]?.partDigest).toBe(sha256(artifact));
});

when("the run delivers the artifact", async value => {
	const world = w(value);
	const record = asRecord(world.response);
	const harness = record?.["harness"] as RuntimeHarness | undefined;
	const artifact = record?.["artifact"];
	const review = record?.["record"];
	if (harness === undefined || typeof artifact !== "string" || review === undefined) {
		throw new Error("no reviewed artifact was prepared");
	}
	const input = { body: artifact };
	await harness.rpc.send("setJudge", {
		answers: {
			action: { label: "off_course", confidence: 0.99 },
			within_authority: { probability: 0.99, confidence: 0.99 },
			external_delivery: { label: "delivers", confidence: 0.99 },
			reviewed_delivery: { probability: 0.01, confidence: 0.99 },
		},
	});
	world.judged = valueOf(
		await harness.rpc.send("judge", {
			material: {
				...actionMaterial("send_email", "reviewed result", input, "reviewed-call"),
				reviewedArtifacts: [review],
			},
			questions: [
				...ACTION_QUESTIONS,
				{
					name: "external_delivery",
					mode: "choice",
					instructions: "Does it deliver externally?",
					options: { delivers: "delivers", does_not_deliver: "local", unclear: "unknown" },
				},
				{
					name: "reviewed_delivery",
					mode: "noul",
					instructions: "Does it deliver only the reviewed bytes?",
					trueMeaning: "same bytes",
					falseMeaning: "changed or unproved",
				},
			],
		}),
	);
	expect(outcomeOf(world.judged)["ok"]).toBe(true);
	expect(harness.store.read(harness.runId).pending).toEqual({});
	const route = await harness.rpc.send("before", {
		event: { type: "tool_call", toolCallId: "reviewed-call", toolName: "send_email", input },
	});
	expect(route).toBeNull();
	const admitted = valueOf(
		await harness.rpc.send("admit", {
			event: { type: "tool_call", toolCallId: "reviewed-call", toolName: "send_email", input },
		}),
	);
	expect(admitted["ok"]).toBe(true);
	world.input = input;
	world.callId = "reviewed-call";
	world.response = { harness, artifact, review, input };
});

then("the deterministic policy admits the effect", value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined || world.callId === undefined) throw new Error("no delivered artifact");
	const run = harness.store.read(harness.runId);
	expect(run.policy.effects).toContain("publication");
	expect(run.pending[world.callId]).toBeDefined();
	expect(eventsOf(harness, "intent.admit").some(event => asRecord(event.data)?.["id"] === world.callId)).toBe(true);
});

then("delivered content matches the reviewed bytes", value => {
	const world = w(value);
	const harness = world.runtime;
	const record = asRecord(world.response);
	const artifact = record?.["artifact"];
	const review = asRecord(record?.["review"]);
	const input = asRecord(record?.["input"]);
	if (harness === undefined || typeof artifact !== "string" || input === undefined) {
		throw new Error("no delivered artifact");
	}
	expect(input["body"]).toBe(artifact);
	expect(review?.["partDigest"]).toBe(sha256(artifact));
	const payload = asRecord(harness.store.read(harness.runId).pending[world.callId ?? ""]?.payload);
	expect(payload?.["invocationDigest"]).toBe(sha256(JSON.stringify(input)));
	expect(payload?.["invocation"]).toBe(JSON.stringify(input));
});

then("a Jev finding is recorded as evidence, not as delivery permission", value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined || world.callId === undefined) throw new Error("no delivered artifact");
	const payload = asRecord(harness.store.read(harness.runId).pending[world.callId]?.payload);
	const diagnostic = asRecord(payload?.["diagnosticDecision"]);
	expect(diagnostic).toBeDefined();
	expect(diagnostic?.["accepted"]).toBe(false);
	expect(eventsOf(harness, "judge.result")).toHaveLength(1);
	const judged = eventsOf(harness, "judge.result")[0];
	const admitted = eventsOf(harness, "intent.admit")[0];
	if (judged === undefined || admitted === undefined) throw new Error("the delivery has no judge/admission trail");
	expect(judged.sequence).toBeLessThan(admitted.sequence);
});

// ---------------------------------------------------------------------------
// Scenario 19: a known-running asynchronous effect keeps the run uncompleted.
// ---------------------------------------------------------------------------

given("a committed strict intent has a native background job known to be running", async value => {
	const world = w(value);
	const env = makeRuntimeEnv("Run the background worker and observe its result.");
	const harness = await spawnRuntime(env);
	world.runtime = harness;
	world.runId = env.runId;
	world.callId = "long-call";
	world.input = { command: "sh worker.sh" };
	await harness.rpc.send("state");
	await harness.rpc.send("judge", {
		material: actionMaterial("bash", "sh worker.sh", world.input, world.callId),
		questions: ACTION_QUESTIONS,
	});
	const admitted = valueOf(
		await harness.rpc.send("admit", {
			event: { type: "tool_call", toolCallId: world.callId, toolName: "bash", input: world.input },
		}),
	);
	expect(admitted["ok"]).toBe(true);
	await harness.rpc.send("result", {
		event: {
			type: "tool_result",
			toolCallId: world.callId,
			toolName: "bash",
			input: world.input,
			content: [{ type: "text", text: "Backgrounded as job bg_1" }],
			isError: false,
			details: { async: { state: "running", jobId: "bg_1", type: "bash" } },
		},
	});
	const payload = asRecord(harness.store.read(env.runId).pending[world.callId]?.payload);
	expect(payload?.["backgroundState"]).toBe("running");
	world.revision = harness.store.read(env.runId).checkpoint.revision;
});

when("the run evaluates completion or rotation", async value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	world.judged = valueOf(await harness.rpc.send("stop"));
});

then("the run remains in a waiting state for that effect", value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined || world.callId === undefined) throw new Error("no bound runtime");
	const run = harness.store.read(harness.runId);
	expect(run.pending[world.callId]).toBeDefined();
	expect(run.waiting?.kind).toBe("pending_effects");
	expect(run.status).not.toBe("completed");
});

then("the launch receipt is not recorded as a completed effect", value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined || world.callId === undefined) throw new Error("no bound runtime");
	const run = harness.store.read(harness.runId);
	expect(run.checkpoint.completion).toBeUndefined();
	expect(run.checkpoint.actions).toEqual([]);
	expect(run.checkpoint.revision).toBe(world.revision ?? -1);
	const payload = asRecord(run.pending[world.callId]?.payload);
	expect(payload?.["unknown"]).not.toBe(true);
	expect(payload?.["backgroundUnproved"]).not.toBe(true);
	expect(eventsOf(harness, "completed")).toEqual([]);
});

then("terminal completion is not committed before observation", value => {
	const world = w(value);
	const harness = world.runtime;
	if (harness === undefined) throw new Error("no bound runtime");
	const decision = asRecord(world.judged)?.["decision"];
	expect(decision).toBeNull();
	const run = harness.store.read(harness.runId);
	expect(run.status).not.toBe("completed");
	expect(run.status).not.toBe("cancelled");
	expect(run.status).not.toBe("infeasible");
	expect(eventsOf(harness, "completed")).toEqual([]);
	expect(run.pending["long-call"]).toBeDefined();
});
