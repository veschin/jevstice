import { answerOf, type Judge, type JudgeQuestion } from "./judge.js";
import { sha256 } from "./state.js";
import { asRecord, POLICY, type ToolOutcome } from "./types.js";

type Verify = (source: string, quote: string, whole?: boolean) => boolean;
type Ref = { source: string; quote: string; whole?: boolean };
type Requirement = Ref & { id: string };
type Need = { id: string; output: string; when: "verified" | "reported" };
type Check = { procedure: string; wrongResult: string; existing?: Ref };
type Report = { kind: "verified" | "blocked"; fingerprint: string; procedure: string; observation: Ref };
type Task = { id: string; result: string; requirements: string[]; needs: Need[]; inputs: Ref[]; check?: Check; question?: string; report?: Report };
type Epic = { id: string; tasks: Task[]; archived: boolean };
type Project = { plan: Ref; requirements: Requirement[]; epics: Epic[] };
type Parsed = { project: Project; proposedText: (ids: Set<string>) => string };
type TaskState = "ready" | "waiting" | "blocked" | "verified" | "question" | "unverified_source" | "unplanned" | "invalid";
type ResumeRow = {
	id: string;
	epic: string;
	archived: boolean;
	state: TaskState;
	fingerprint?: string;
	reportState: "absent" | "stale" | "unobserved" | "applicable";
	observation?: Ref;
	procedure?: string;
	detail?: string;
	priorReport?: Report;
	waitingFor?: string[];
};

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
const invalid = (reason: string): ToolOutcome => ({ ok: false, text: `TODO not run: ${reason}`, details: { kind: "invalid" } });
const unclear = (reason: string): ToolOutcome => ({ ok: false, text: `TODO needs input: ${reason}`, details: { kind: "unclear" } });
const ref = (value: unknown): Ref => {
	const row = asRecord(value);
	if (!row || !text(row.source) || !text(row.quote) || (row.whole !== undefined && typeof row.whole !== "boolean")) {
		throw new Error("each evidence reference requires source and exact quote; whole is optional");
	}
	return { source: row.source, quote: row.quote, ...(row.whole === true ? { whole: true } : {}) };
};
const group = (value: unknown, description: string): unknown[] => {
	if (!Array.isArray(value)) throw new Error(`${description} must be an array`);
	return value;
};
const parseTask = (value: unknown): Task => {
	const row = asRecord(value);
	if (!row || !id(row.id) || !text(row.result)) throw new Error("each task requires a stable id and observable result");
	const requirements = group(row.requirements, `${row.id} requirements`);
	if (!requirements.every(id)) throw new Error(`${row.id}: requirement references must be stable IDs`);
	const needs = group(row.needs === undefined ? [] : row.needs, `${row.id} needs`).map(value => {
		const need = asRecord(value);
		if (!need || !id(need.id) || !text(need.output) || (need.when !== undefined && need.when !== "verified" && need.when !== "reported")) {
			throw new Error(`${row.id}: each prerequisite requires an id, consumed output, and optional when (verified or reported)`);
		}
		return { id: need.id, output: need.output, when: need.when === "reported" ? "reported" as const : "verified" as const };
	});
	const check = asRecord(row.check);
	if (row.check !== undefined && (!check || !text(check.procedure) || !text(check.wrongResult))) {
		throw new Error(`${row.id}: a check must name its procedure and the plausible wrong result it should catch`);
	}
	const report = asRecord(row.report);
	if (row.report !== undefined && (!report || (report.kind !== "verified" && report.kind !== "blocked") ||
		typeof report.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(report.fingerprint) || !text(report.procedure))) {
		throw new Error(`${row.id}: a report requires kind, task fingerprint, procedure and observed result`);
	}
	if (row.question !== undefined && !text(row.question)) throw new Error(`${row.id}: question must state the unresolved decision`);
	const inputs = group(row.inputs === undefined ? [] : row.inputs, `${row.id} inputs`).map(value => ({ ...ref(value), whole: true }));
	return {
		id: row.id, result: row.result, requirements, needs, inputs,
		question: text(row.question) ? row.question : undefined,
		check: check && text(check.procedure) && text(check.wrongResult) ? {
			procedure: check.procedure, wrongResult: check.wrongResult, existing: check.existing === undefined ? undefined : ref(check.existing),
		} : undefined,
		report: report && (report.kind === "verified" || report.kind === "blocked") && typeof report.fingerprint === "string" && text(report.procedure) ? {
			kind: report.kind, fingerprint: report.fingerprint, procedure: report.procedure, observation: ref(report.observation),
		} : undefined,
	};
};

const parse = (artifact: string): Parsed => {
	const blocks = [...artifact.matchAll(/^```jev-todo-v1[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
	const block = blocks[0];
	if (blocks.length > 1 || (!block && !artifact.trimStart().startsWith("{"))) {
		throw new Error("provide one jev-todo-v1 Markdown fence or a standalone version 1 JSON document");
	}
	const raw = asRecord(JSON.parse(block?.[1] ?? artifact));
	if (!raw || raw.version !== 1) throw new Error("TODO document must have version: 1");
	const rawEpics = group(raw.epics, "epics");
	const project: Project = {
		plan: ref(raw.plan),
		requirements: group(raw.requirements, "requirements").map(value => {
			const row = asRecord(value);
			if (!row || !id(row.id)) throw new Error("each requirement needs a stable id and authoritative source");
			return { id: row.id, ...ref(row) };
		}),
		epics: rawEpics.map(value => {
			const row = asRecord(value);
			if (!row || !id(row.id) || (row.archived !== undefined && typeof row.archived !== "boolean")) throw new Error("each epic needs a stable id and optional archived flag");
			const tasks = group(row.tasks, `${row.id} tasks`).map(parseTask);
			if (tasks.length === 0) throw new Error(`${row.id}: an epic cannot be empty`);
			return { id: row.id, tasks, archived: row.archived === true };
		}),
	};
	if (project.requirements.length > 200 || project.epics.reduce((n, epic) => n + epic.tasks.length, 0) > 200) throw new Error("at most 200 requirements and 200 tasks per TODO document");
	return {
		project,
		proposedText: ids => {
			const epics = rawEpics.map(value => {
				const row = asRecord(value)!;
				return typeof row.id === "string" && ids.has(row.id) ? {
					...row, archived: true, archiveReason: row.archiveReason ?? "All task verification remained applicable at the configured cleanup review.",
				} : row;
			});
			const json = JSON.stringify({ ...raw, epics }, null, 2);
			if (!block || block.index === undefined) return json + (artifact.endsWith("\n") ? "\n" : "");
			const start = artifact.indexOf("\n", block.index) + 1;
			const end = start + (block[1]?.length ?? 0);
			const newline = artifact[start - 2] === "\r" ? "\r\n" : "\n";
			return artifact.slice(0, start) + json.replaceAll("\n", newline) + newline + artifact.slice(end);
		},
	};
};

const repeated = (ids: string[]): string[] => {
	const seen = new Set<string>();
	return [...new Set(ids.filter(id => seen.has(id) || !seen.add(id)))];
};

const analyze = (project: Project) => {
	const tasks = project.epics.flatMap(epic => epic.tasks);
	const byId = new Map(tasks.map(task => [task.id, task]));
	const requirements = new Map(project.requirements.map(row => [row.id, row]));
	const duplicateIds = {
		tasks: repeated(tasks.map(task => task.id)), requirements: repeated(project.requirements.map(row => row.id)), epics: repeated(project.epics.map(row => row.id)),
	};
	const missingPredecessors: { task: string; predecessor: string }[] = [];
	const invalidRequirements: { task: string; requirement: string }[] = [];
	const duplicateLinks: { task: string; id: string; type: "requirement" | "predecessor" }[] = [];
	const cycles: string[][] = [];
	const invalidTasks = new Set<string>();
	const consumers = new Map<string, Task[]>();
	const mapped = new Map<string, Task[]>();
	for (const task of tasks) {
		for (const [type, links] of [["requirement", task.requirements], ["predecessor", task.needs.map(need => need.id)]] as const) {
			for (const id of repeated(links)) {
				duplicateLinks.push({ task: task.id, id, type });
				invalidTasks.add(task.id);
			}
		}
		for (const need of task.needs) {
			if (byId.has(need.id)) {
				const list = consumers.get(need.id) ?? [];
				list.push(task);
				consumers.set(need.id, list);
			} else {
				missingPredecessors.push({ task: task.id, predecessor: need.id });
				invalidTasks.add(task.id);
			}
		}
		for (const id of task.requirements) {
			if (!requirements.has(id)) {
				invalidRequirements.push({ task: task.id, requirement: id });
				invalidTasks.add(task.id);
			} else {
				const list = mapped.get(id) ?? [];
				list.push(task);
				mapped.set(id, list);
			}
		}
	}
	const visited = new Set<string>();
	const path: string[] = [];
	const visit = (task: Task): void => {
		const start = path.indexOf(task.id);
		if (start >= 0) {
			const cycle = path.slice(start);
			for (const member of cycle) invalidTasks.add(member);
			cycles.push([...cycle, task.id]);
			return;
		}
		if (visited.has(task.id)) return;
		visited.add(task.id);
		path.push(task.id);
		for (const need of task.needs) {
			const predecessor = byId.get(need.id);
			if (predecessor) visit(predecessor);
		}
		path.pop();
	};
	for (const task of tasks) visit(task);
	const reachesRequirement = new Set<string>();
	const requiredQueue = tasks.filter(task => task.requirements.length > 0 && !task.question && !invalidTasks.has(task.id));
	for (const task of requiredQueue) reachesRequirement.add(task.id);
	for (const task of requiredQueue) {
		for (const need of task.needs) {
			const predecessor = byId.get(need.id);
			if (predecessor && !invalidTasks.has(predecessor.id) && !reachesRequirement.has(predecessor.id)) {
				reachesRequirement.add(predecessor.id);
				requiredQueue.push(predecessor);
			}
		}
	}
	return {
		tasks, byId, requirements, consumers, mapped, invalidTasks, reachesRequirement,
		graph: { duplicateIds, missingPredecessors, invalidRequirements, duplicateLinks, cycles },
		unmapped: project.requirements.filter(row => !mapped.has(row.id)).map(row => row.id),
		ambiguous: Object.values(duplicateIds).some(ids => ids.length > 0),
	};
};

type Analysis = ReturnType<typeof analyze>;

const checkSources = (project: Project, verify: Verify) => {
	const seen = new Map<string, boolean>();
	const observed = (ref: Ref): boolean => {
		const key = JSON.stringify([ref.source, ref.quote, ref.whole === true]);
		const previous = seen.get(key);
		if (previous !== undefined) return previous;
		const current = verify(ref.source, ref.quote, ref.whole);
		seen.set(key, current);
		return current;
	};
	const planObserved = observed(project.plan);
	const unobservedRequirements = project.requirements.filter(row => !observed(row)).map(row => row.id);
	return { observed, planObserved, unobservedRequirements };
};

type Sources = ReturnType<typeof checkSources>;

const resume = (project: Project, analysis: Analysis, sources: Sources) => {
	const rows = new Map<string, ResumeRow>();
	const epics = new Map(project.epics.flatMap(epic => epic.tasks.map(task => [task.id, epic] as const)));
	const compute = (task: Task): ResumeRow => {
		const previous = rows.get(task.id);
		if (previous) return previous;
		const epic = epics.get(task.id)!;
		const row: ResumeRow = {
			id: task.id, epic: epic.id, archived: epic.archived, state: "invalid", reportState: task.report ? "stale" : "absent",
			priorReport: task.report,
		};
		rows.set(task.id, row);
		if (analysis.invalidTasks.has(task.id)) {
			row.detail = "Resolve graph defects for this task.";
			return row;
		}
		const requirements = task.requirements.map(id => analysis.requirements.get(id)!);
		const predecessors = task.needs.map(need => ({ ...need, row: compute(analysis.byId.get(need.id)!) }));
		row.fingerprint = sha256(JSON.stringify({
			protocol: 1, plan: project.plan, id: task.id, result: task.result, requirements, inputs: task.inputs, check: task.check, question: task.question,
			needs: predecessors.map(({ row, ...need }) => [need, row.fingerprint, row.state === "verified" || row.state === "blocked" ? [row.state, row.procedure, row.observation] : null]),
		}));
		if (task.question) {
			row.state = "question";
			row.detail = task.question;
			return row;
		}
		if (!sources.planObserved || [...requirements, ...task.inputs].some(ref => !sources.observed(ref))) {
			row.state = "unverified_source";
			row.detail = "Read the authoritative plan and this task's requirement/input sources at their current versions.";
			return row;
		}
		if (!task.check || !analysis.reachesRequirement.has(task.id)) {
			row.state = "unplanned";
			row.detail = !task.check ? "Name a check and the wrong result it must reject." : "Link a required outcome or the downstream task that consumes this output.";
			return row;
		}
		const waiting = predecessors.filter(need => need.row.state !== "verified" && !(need.when === "reported" && need.row.state === "blocked"));
		if (waiting.length) row.waitingFor = waiting.map(need => `${need.id}: ${need.output} (${need.when})`);
		const report = task.report;
		if (report && report.fingerprint === row.fingerprint && (report.kind === "blocked" || report.procedure === task.check.procedure)) {
			// A fingerprint copied into a TODO row does not bind old output to a new run.
			const marker = `jev-todo-v1 ${task.id} ${row.fingerprint} ${report.kind}`;
			const lines = report.observation.quote.split(/\r?\n/);
			const markers = lines.filter(line => line.startsWith("jev-todo-v1 "));
			if (markers.length === 1 && markers[0] === marker && lines.some(line => line !== marker && line.trim().length > 0)) {
				if (!sources.observed(report.observation)) row.reportState = "unobserved";
				else if (!waiting.length || report.kind === "blocked") {
					row.state = report.kind;
					row.reportState = "applicable";
					row.observation = report.observation;
					row.procedure = report.procedure;
					return row;
				}
			}
		}
		row.state = waiting.length ? "waiting" : "ready";
		return row;
	};
	return analysis.tasks.map(compute);
};

const necessity = {
	required: "The observable outcome is required by the verified clauses.",
	enabling: "A named direct or transitive consumer needs this output to deliver a required outcome.",
	unsupported_scope: "No verified requirement or necessary downstream prerequisite needs this result.",
	question: "An unresolved decision prevents asserting this expected outcome; keep it as a question.",
	unclear: "The provided material cannot settle necessity.",
};
const checks = {
	falsifiable: "The specified procedure would reject the named plausible wrong result.",
	reuse_existing: "The independently observed existing check already detects the same wrong result; reuse it rather than adding another check.",
	weak_check: "The procedure could pass despite the named or another material wrong result, or does not examine the required behavior.",
	unclear: "The material does not establish what result the check can reject.",
};
const edges = {
	necessary: "Every stated output is actually required by this task before the stated phase can proceed.",
	unnecessary: "An edge is ordering preference, redundant/transitive, or names an output this task does not require.",
	missing: "A concrete predecessor necessary to run this task is not listed.",
	unclear: "The task and supplied outputs do not settle dependency adequacy.",
};
const coverage = {
	covered: "The mapped task outcomes and checks cover this requirement, including materially different cases stated in its quote.",
	missing_coverage: "Some required outcome or materially different case is omitted or has no meaningful check.",
	question: "Coverage depends on an expressly unresolved decision, not an assumed expected result.",
	unclear: "The scope or available evidence is not sufficient to establish coverage.",
};
const inventory = {
	complete: "The cited requirement inventory represents the deliverables and constraints in the authoritative plan.",
	incomplete: "The plan calls for an outcome or constraint not represented in the requirement inventory.",
	unclear: "The authoritative plan quote does not establish completeness.",
};
const choice = (name: string, instructions: string, options: Record<string, string>): JudgeQuestion => ({ name, mode: "choice", instructions, options });

const review = async (judge: Judge, project: Project, analysis: Analysis, sources: Sources, rows: ResumeRow[]) => {
	const questions: JudgeQuestion[] = [];
	const options = new Map<string, Readonly<Record<string, string>>>();
	const add = (question: JudgeQuestion): void => {
		questions.push(question);
		options.set(question.name, question.options!);
	};
	const usable = (row: ResumeRow) => row.state !== "invalid" && row.state !== "unverified_source" && row.state !== "question";
	const reviewable = analysis.tasks.filter((_, index) => usable(rows[index]!));
	const reviewed = new Set(reviewable.map(task => task.id));
	const missingRequirementSources = new Set(sources.unobservedRequirements);
	const requirementCoverage = project.requirements.map(requirement => {
		const mapped = analysis.mapped.get(requirement.id) ?? [];
		return { id: requirement.id, tasks: mapped.map(task => task.id), verdict: !sources.planObserved || missingRequirementSources.has(requirement.id) ? "unclear" :
			mapped.length === 0 ? "missing_coverage" : mapped.every(task => task.question) ? "question" :
			mapped.some(task => reviewed.has(task.id) && task.check) ? "pending" : "unclear" };
	});
	if (sources.planObserved && missingRequirementSources.size === 0) {
		add(choice("inventory", "Compare the verified authoritative plan with the supplied authoritative requirement clauses. Is any required deliverable or constraint absent? Do not turn questions into expected behavior.", inventory));
	}
	for (const [index, task] of reviewable.entries()) {
		const subject = `For task ${JSON.stringify(task.id)}`;
		if (analysis.reachesRequirement.has(task.id)) {
			add(choice(`necessity_${index}`, `${subject}, would removal lose any required result or output consumed by required work? Do not judge size, task count, effort or atomicity. A cited ID alone does not establish scope.`, necessity));
		}
		if (task.check) {
			const existing = task.check.existing && sources.observed(task.check.existing);
			add(choice(`check_${index}`, `${subject}, could the stated check pass even if the plausible wrong result occurred? Match actual assertions and end state, not success/status alone. An equivalent executable check is enough; Gherkin is not required.`, {
				falsifiable: checks.falsifiable, weak_check: checks.weak_check, unclear: checks.unclear, ...(existing ? { reuse_existing: checks.reuse_existing } : {}),
			}));
		}
		add(choice(`dependencies_${index}`, `${subject}, compare its real prerequisite outputs against the proposed graph. A topic overlap, ordering preference, or transitive edge is not a direct need.`, edges));
		const peers = Object.fromEntries(reviewable.flatMap((peer, other) => other < index ? [[`task_${other}`, `Task ${JSON.stringify(peer.id)} already delivers the same required outcome or independently checks the same wrong result; this is a duplicate, not merely related.`]] : []));
		if (index > 0) add(choice(`duplicate_${index}`, `${subject}, compare its result AND what wrong behavior its check detects against the earlier tasks. Do not mark distinct outcomes that share a test harness, procedure, or topic as duplicates. Select the exact duplicate task only where no independent result/check is lost.`, {
			distinct: "No earlier task duplicates this task outcome or check.", unclear: "The comparison is not settled.", ...peers,
		}));
	}
	for (const [index, row] of requirementCoverage.entries()) {
		if (row.verdict === "pending") add(choice(`coverage_${index}`, `Evaluate requirement ${JSON.stringify(row.id)} against its verified clause and mapped tasks. A reference alone does not establish coverage. Look for omitted results or wrong behaviors that the checks would accept, not formatting or task count.`, coverage));
	}
	const judgeResult = questions.length ? await judge({
		plan: sources.planObserved ? project.plan : undefined,
		requirements: project.requirements.filter(row => !missingRequirementSources.has(row.id)),
		// Do not pass caller-supplied unobserved proof, even as a convenient-looking excerpt.
		tasks: analysis.tasks.map((task, index) => ({ id: task.id, result: task.result, requirements: task.requirements, needs: task.needs, question: task.question,
			availableForCoverage: usable(rows[index]!),
			check: task.check ? { procedure: task.check.procedure, wrongResult: task.check.wrongResult,
				existing: task.check.existing && sources.observed(task.check.existing) ? task.check.existing : undefined,
			} : undefined,
		})),
	}, questions).catch(() => ({ ok: false as const, kind: "unavailable" as const, problem: "judge request failed" })) : undefined;
	const decide = (name: string): { verdict: string; confidence?: number } => {
		if (!judgeResult) return { verdict: "unclear" };
		const answer = answerOf(judgeResult, name);
		const label = answer?.label;
		return {
			verdict: label && answer?.mode === "choice" && answer.confidence >= POLICY.minConfidenceToApprove && Object.hasOwn(options.get(name) ?? {}, label) ? label : "unclear",
			confidence: answer?.confidence,
		};
	};
	const judgedIndices = new Map(reviewable.map((task, index) => [task.id, index]));
	const findings = analysis.tasks.map((task, index) => {
		const judged = judgedIndices.get(task.id);
		const necessity = task.question ? { verdict: "question" } : judged === undefined ? { verdict: "unclear" } :
			analysis.reachesRequirement.has(task.id) ? decide(`necessity_${judged}`) : { verdict: "unsupported_scope" };
		const check = task.question ? { verdict: "question" } : !task.check ? { verdict: "missing_check" } : judged === undefined ? { verdict: "unclear" } : decide(`check_${judged}`);
		const dependencies = judged === undefined ? { verdict: "unclear" } : decide(`dependencies_${judged}`);
		const duplicate = judged === undefined ? { verdict: "unclear" } : judged === 0 ? { verdict: "distinct" } : decide(`duplicate_${judged}`);
		const earlier = duplicate.verdict.startsWith("task_") ? reviewable[Number(duplicate.verdict.slice(5))] : undefined;
		return {
			id: task.id, epic: rows[index]?.epic, result: task.result, requirementIds: task.requirements,
			consumers: (analysis.consumers.get(task.id) ?? []).map(consumer => ({ id: consumer.id, output: consumer.needs.find(need => need.id === task.id)?.output })),
			necessity, check, dependencies, duplicate: earlier ? { ...duplicate, verdict: "duplicate", of: earlier.id } : duplicate,
			procedure: task.check?.procedure, wrongResult: task.check?.wrongResult,
			existing: task.check?.existing ? { ...task.check.existing, observed: sources.observed(task.check.existing) } : undefined,
			question: task.question,
		};
	});
	const reviewedCoverage = requirementCoverage.map((row, index) => row.verdict === "pending" ? { ...row, ...decide(`coverage_${index}`) } : row);
	return { findings, reviewedCoverage, inventory: decide("inventory"), judgeResult };
};

/** Optional diagnostics; this never executes a check, changes the project file, or authorizes dispatch. */
export const todoWork = async (judge: Judge, params: unknown, verify: Verify): Promise<ToolOutcome> => {
	const input = asRecord(params);
	if (!input || (input.action !== "review" && input.action !== "resume" && input.action !== "cleanup") || !text(input.source) || !text(input.artifact)) {
		return invalid("provide action (review, resume, cleanup), source, and the current whole project TODO artifact");
	}
	if (input.threshold !== undefined && (input.action !== "cleanup" || typeof input.threshold !== "number" || !Number.isSafeInteger(input.threshold) || input.threshold < 1)) {
		return invalid("threshold is a positive configured integer for cleanup only");
	}
	const { action, source, artifact } = input;
	if (artifact.length > 256_000) return invalid("TODO artifact exceeds 256,000 characters");
	if (!verify(source, artifact, true)) return unclear("read the whole current project TODO artifact; a fragment or prior observation cannot drive resumption");
	const parsed = (() => {
		try { return parse(artifact); } catch (error) { return error instanceof Error ? error.message : "malformed TODO document"; }
	})();
	if (typeof parsed === "string") return invalid(parsed);
	const { project } = parsed;
	const analysis = analyze(project);
	const { graph, unmapped } = analysis;
	const artifactDigest = sha256(artifact);
	const common = { action, artifactDigest, source, graph, unmapped };
	if (analysis.ambiguous) return { ok: false, text: `TODO ${action}: duplicate stable IDs: ${Object.values(graph.duplicateIds).flat().join(", ")}.`, details: { ...common, kind: "defect" } };
	const graphDefect = graph.missingPredecessors.length > 0 || graph.invalidRequirements.length > 0 || graph.duplicateLinks.length > 0 || graph.cycles.length > 0;
	const graphLines = [
		...graph.missingPredecessors.map(row => `${row.task}: missing predecessor ${row.predecessor}.`),
		...graph.invalidRequirements.map(row => `${row.task}: unknown requirement ${row.requirement}.`),
		...graph.duplicateLinks.map(row => `${row.task}: duplicate ${row.type} ${row.id}.`),
		...graph.cycles.map(cycle => `Dependency cycle: ${cycle.join(" -> ")}.`),
		...(unmapped.length ? [`Requirements with no task: ${unmapped.join(", ")}.`] : []),
	];
	const sources = checkSources(project, verify);
	const authority = { planObserved: sources.planObserved, unobservedRequirements: sources.unobservedRequirements };
	const rows = resume(project, analysis, sources);
	const missingAuthority = !authority.planObserved || authority.unobservedRequirements.length > 0;
	const sourceGap = missingAuthority || rows.some(row => row.state === "unverified_source");
	const defects = graphDefect || unmapped.length > 0;
	if (action === "resume") {
		const ready = rows.filter(row => row.state === "ready" && !row.archived).map(row => row.id);
		const next = ready[0] === undefined ? undefined : analysis.byId.get(ready[0]);
		const summary = [
			`TODO resume: next ${ready[0] ?? "none"}; ready ${ready.join(", ") || "none"}.`,
			...rows.map(row => `- ${row.id}: ${row.state}${row.archived ? " (archived)" : ""}; report ${row.reportState}${row.waitingFor ? `; needs ${row.waitingFor.join(", ")}` : ""}${row.detail ? `; ${row.detail}` : ""}.${row.observation ? ` Observed at ${row.observation.source}.` : ""}${row.state === "ready" && row.fingerprint ? ` Fingerprint: ${row.fingerprint}` : ""}`),
			...(next?.check ? [`Next check: ${next.check.procedure} Reject: ${next.check.wrongResult}`] : []),
			...graphLines,
		];
		const kind = defects ? "defect" : sourceGap ? "unclear" : "reviewed";
		return { ok: kind === "reviewed", text: summary.join("\n"), details: { ...common, kind, authority, tasks: rows, ready, next: ready[0] ?? null } };
	}
	if (action === "cleanup") {
		const verified = new Set(rows.filter(row => row.state === "verified").map(row => row.id));
		const completed = project.epics.filter(epic => !epic.archived && epic.tasks.every(task => verified.has(task.id))).map(epic => epic.id);
		const threshold = typeof input.threshold === "number" ? input.threshold : undefined;
		const policyGap = threshold === undefined;
		const proposedArchive = !defects && !sourceGap && !policyGap && completed.length >= threshold ? completed : [];
		const proposedIds = new Set(proposedArchive);
		const archivedTaskIds = new Set(project.epics.filter(epic => proposedIds.has(epic.id)).flatMap(epic => epic.tasks.map(task => task.id)));
		const preservedLinks = analysis.tasks.flatMap(task => task.needs.filter(need => archivedTaskIds.has(need.id)).map(need => ({ from: task.id, to: need.id })));
		const proposal = proposedArchive.length ? parsed.proposedText(proposedIds) : null;
		const kind = defects ? "defect" : policyGap || sourceGap ? "unclear" : "reviewed";
		const message = policyGap ? "set the owner's cleanup threshold; no default is assumed" : defects ? "fix dependency or coverage gaps before proposing archive changes" :
			sourceGap ? "reread the plan and unobserved task inputs before proposing archive changes" :
			proposal ? `proposed archive/history for ${proposedArchive.join(", ")}; all original rows, IDs and dependency links remain in the same file` : `${completed.length} completed active epics; threshold ${threshold} not reached`;
		return { ok: kind === "reviewed", text: [`TODO cleanup: ${message}. No files changed.`, ...graphLines].join("\n"), details: { ...common, kind, authority, threshold, policyGap, completed, proposedArchive, preservedLinks, proposal } };
	}
	const report = await review(judge, project, analysis, sources, rows);
	const labels = report.findings.flatMap(row => [row.necessity.verdict, row.check.verdict, row.dependencies.verdict, row.duplicate.verdict]);
	const coverageLabels = report.reviewedCoverage.map(row => row.verdict);
	const defect = defects || labels.some(label => ["unsupported_scope", "weak_check", "missing_check", "unnecessary", "missing", "duplicate", "reuse_existing"].includes(label)) ||
		coverageLabels.includes("missing_coverage") || report.inventory.verdict === "incomplete";
	const unavailable = report.judgeResult?.ok === false && report.judgeResult.kind === "unavailable";
	const unsettled = sourceGap || labels.some(label => label === "unclear" || label === "question") || coverageLabels.some(label => label === "unclear" || label === "question") || report.inventory.verdict === "unclear";
	const kind = defect ? "defect" : unavailable ? "unavailable" : unsettled ? "unclear" : "reviewed";
	return {
		ok: kind === "reviewed",
		text: [
			`TODO review: ${kind}. Plan inventory: ${report.inventory.verdict}.`,
			...graphLines,
			...report.reviewedCoverage.map(row => `- ${row.id}: ${row.verdict}${row.tasks.length ? ` (${row.tasks.join(", ")})` : ""}.`),
			...report.findings.map(row => `- ${row.id}: ${row.necessity.verdict}${row.requirementIds.length ? ` [${row.requirementIds.join(", ")}]` : ""}${row.consumers.length ? `; consumed by ${row.consumers.map(consumer => `${consumer.id}: ${consumer.output}`).join(", ")}` : ""}; check ${row.check.verdict}; dependencies ${row.dependencies.verdict}; ${"of" in row.duplicate ? `duplicates ${row.duplicate.of}` : row.duplicate.verdict}.${row.check.verdict === "reuse_existing" && row.existing ? ` Reuse ${row.existing.source}.` : ""}${row.wrongResult ? ` Wrong result under review: ${row.wrongResult}` : ""}${row.question ? ` Open question: ${row.question}` : ""}`),
			...(report.judgeResult?.ok === false ? [`Judge ${report.judgeResult.kind}: ${report.judgeResult.problem}.`] : []),
		].join("\n"),
		details: { ...common, kind, authority, judgeUnavailable: unavailable, inventory: report.inventory, coverage: report.reviewedCoverage, tasks: report.findings },
	};
};
