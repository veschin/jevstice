/**
 * The one canonical tool catalog: registration reads it and the startup prompt is derived from it.
 *
 * Every entry carries the registered purpose, the guide to its accepted arguments (including the
 * optional fields its example does not show) and one call that is valid as written. A description
 * here is the only place a tool is documented, so a changed schema and a changed guide cannot drift
 * apart. The module imports schema types only; it never imports controller runtime.
 */
import type { SchemaBuilder } from "./controller.js";

/** One registered tool, before its executor is attached. */
export interface ToolCatalogEntry {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	example: Record<string, unknown>;
}

const CONSULT_DESCRIPTION =
	"Use one decision to settle what the code and the owner request do not, or to recover from a refusal finding. Arguments: mode (required: choice, score, boolean or recovery). For choice, score and boolean, question (one decision) and context (the state the decision rests on - the judge sees only what you submit here and in evidence) are required by the backend and optional in the schema so a recovery call can omit them, plus alternatives (choice: two or more {label, meaning}, each naming what choosing it commits to), criteria (score: two or more ordered rubric steps) or trueMeaning and falseMeaning (boolean: what yes and what no commit to). Those three modes are diagnostic: they stay usable while a finding holds work and never clear a finding. For recovery, submit recovery {findingId (the held id reported by jev_context list), phase: repair or resolve, diagnosis (an observable cause), correction (what materially changes)} and nonempty evidence; question, context, trueMeaning and falseMeaning are not used, and recovery is rejected on the other modes. phase repair additionally requires nextAction {tool, input}: one exact native tool name (never a jev_* tool) and its complete argument object. The judge answers one canonical boolean repair_action at the unchanged workflow boolean floor (0.7); approval authorizes only that one exact invocation under the unchanged finding, task, owner request, requirements, plan and revision, does not claim the defect is fixed, and leaves every other consequential call held. When the refused action never executed, admitting the exact approved replacement retires that action-preflight finding; any other finding remains until an explicit resolve with observed proof, and requirement or plan review or a resubmission of the same failed judged activity stays callable under the hold without authorizing project effects. phase resolve takes no nextAction and requires the diagnosis, correction and quoted proof; use it only when the correction is observed, and one canonical boolean resolves_hold at the same workflow boolean floor (0.7) clears only the named finding. No caller-submitted question is judged for either phase. Read the held finding and the approved plan first, ask a diagnostic choice when the cause is unknown, and repair the actual artifact or action instead of inferring a cause from a score or asking the owner to override. Duplicate recovery is keyed by phase, exact action, bindings and evidence, not by reworded prose. All normal prerequisites, artifact binding, strict autonomous authority and the enforced external review still apply; a below-floor or inconclusive answer is not approval, and repeating unchanged material never authorizes work.";

const TRIAGE_DESCRIPTION =
	"Submit the owner's request once, before project inspection for a judged change and before any consequential change. Arguments: request (required: the owner's exact words); topics (optional: one narrow topic per concrete area); evidence (optional: exact {kind, quote, source?, sourceId?} items). Development requires requirements and staged plan review; simple names the skipped stages; unsettled registers nothing. A read, search or summary task needs no triage and no tool ritual. Public HTTP(S) URL reads are external evidence and stay available before triage; project reads for a judged change wait for triage. Skill reads and task tracking remain available. The addon admits recognized literal read and search commands, including safe pipelines, without judgment. Unknown wrappers, executable scripts, delegation and unsupported shell syntax still need action authorization even when intended as inspection. Triage also records whether the deliverable is external-facing. Never re-triage to escape a refusal.";

const REAIM_DESCRIPTION =
	"Use only when the owner actually replaces the task direction. Arguments: interjection (required: the owner's words verbatim); evidence (required: at least the same owner text as a {kind: \"user\", quote, sourceId?} item, where a sourceId from jev_context binds it to the recorded message). A clarification, an addition or a follow-up is not a re-aim and is handled through the owner-update path; do not use this tool to escape a refusal or to restore an old direction. Approval drops prior approvals and requires fresh requirements and plan review - no re-triage.";

const SEARCH_DESCRIPTION =
	"Submit one search question with its candidates. Arguments: query (required); candidates (required: two or more {title?, url?, evidence (the exact excerpt), reason (why it answers the query, or why it does not)}). Jev selects a candidate or none; the reason is yours, not Jev's. A below-floor selection is unusable; resubmit only with different candidates or excerpts.";

const REQUIREMENTS_DESCRIPTION =
	"Derive the obligations the owner's request imposes and submit them once. Arguments: request (required: the same owner request); items (required: one {text: a checkable obligation you derived, source: the exact request line it comes from}); candidateNeeds (optional: suspected omissions you want checked, never owner instructions); evidence (optional: quoted {kind, quote, source?, sourceId?} items, with sourceId for recorded owner text). No owner confirmation step exists or is needed. A necessary implementation choice is your decision, not an obligation. Plan artifacts stay held until coverage is established and every submitted item is supported; if coverage fails, add the missing obligation and resubmit rather than rephrasing the same list.";

const PLAN_REVIEW_DESCRIPTION =
	"Staged approval of one plan artifact. Arguments: phase (required: outline, detail or finalize); steps (required for outline: one {id, summary, requirement} per high-level step, each requirement exactly matching one approved obligation); plan (required for detail and finalize: the local:// artifact URL); topic (required for detail: {id, section (the exact heading or the complete section), paths, requirement}); evidence (required: quoted {kind, quote, source?, sourceId?} items - for detail, the step's complete artifact section verbatim). Order is outline, then one detail call per step, then finalize. Passing steps are retained while rejected steps are revised; the original request, approved requirements, full outline and earlier approved details are re-sent with every call. No project file changes before final approval, and a changed artifact reopens the affected steps.";

const ACCEPTANCE_DESCRIPTION =
	"Prove one acceptance aspect at the current revision. Arguments: aspect (required: business or architecture); claim (required: what the owner needed and what this revision achieves); evidence (required: execution evidence quoting the command and its observed output, and code evidence such as a diff, diagnostic or measurement; any item may carry sourceId). Submit business and architecture separately at the current revision; both must pass, and a later consequential change invalidates approval. A refusal names the failing aspect and stays open until the evidence or the implementation changes.";

const REVIEW_DESCRIPTION =
	"Submit one developer review. Arguments: kind (required: checkpoint, commit or diff); target (required: the file or revision reviewed); claim (required: what the change does); evidence (required: changed-code evidence and verification output, each {kind, quote, source?, sourceId?}). A finding holds changes until jev_consult resolves it. This review never replaces business or architecture acceptance.";

const TEXT_REVIEW_DESCRIPTION =
	"Judge prose against explicit rules. Arguments: text (required: the exact text to judge); rules (required: {class, rule, scope?} items, where scope=text judges the whole text once and is the default, scope=fragment judges each prose fragment, and headings and table blocks are never fragments). Submit the exact rules; revise only the returned violating fragments. No returned defect means the text meets the submitted rules.";

const ANTI_SLOP_DESCRIPTION =
	"Use before delivering an external document, research output, legal or other external communication. Arguments: artifact (required: the exact text), language, register, purpose, audience (all required), rules (required: {class, rule, severity?: blocker|warning} items), claims (required: {id, text, kind: fact|hypothesis, evidence [{kind, quote, source?, sourceClass}], falsifier? - a hypothesis needs a falsifier}), inferences (optional: {id, premises, warrant, conclusion}), part (optional: {index, total} when a large artifact is split into numbered parts). Jev marks each claim trusted, low_trust, distrusted or unverified and returns findings; the shipped mode is advisory. Report every finding before reporting the deliverable complete, and the owner waives one with /jev-waive <id> <reason>.";

const CONTEXT_DESCRIPTION =
	"Read the project's trusted context archive. Arguments: action (required: list or read); sourceId (required for read, omitted for list). list returns stable identifiers with kind (owner, requirements or plan), origin, session and approval metadata, and while a finding holds work it also returns that finding's exact original submission and result - read the held material there instead of repeating it. read returns the exact stored content and its digest. The archive holds authentic owner messages and approved requirement and plan snapshots captured by the addon: provenance says where the text came from, not that its assertions are true. Cite stored text in any tool's evidence as {kind, quote, sourceId}, using kind user for owner text; owner is the archive's provenance kind, not an evidence kind. The controller resolves the identifier against the archive, checks the quote is present and rejects missing, changed or mismatched sources without a judge call. Reading never restores approval, permission or execution authority.";

const COURSE_CHECK_DESCRIPTION =
	"Check manually whether current work follows the approved task. Arguments: claim (required: one concise statement of the current work); nextAction (optional: what you intend to do next); evidence (optional: quoted {kind, quote, source?, sourceId?} items). The check evaluates the claim and proposed action against the approved objective, requirements, plan and recent observed actions, and works before any recent action once a plan exists. No plan or insufficient context returns a named prerequisite, not a clean result. A below-floor on_course is no reliable approval and not a proven deviation; only off_course establishes one. An unsupported, off-course or unavailable verdict records a recovery hold; an approving check neither erases another hold, nor authorizes a file change, nor replaces acceptance. Automatic interval and completion checks still run on their own.";

/** Build the complete catalog with the host's schema builder. */
export function createToolCatalog(z: SchemaBuilder): ToolCatalogEntry[] {
	const evidence = z.array(
		z.object({
			kind: z.string(),
			quote: z.string(),
			source: z.string().optional(),
			sourceId: z.string().optional(),
		}),
	);
	const recovery = z.object({
		findingId: z.string(),
		phase: z.enum(["repair", "resolve"]),
		diagnosis: z.string(),
		correction: z.string(),
		nextAction: z
			.object({
				tool: z.string(),
				input: z.unknown(),
			})
			.optional(),
	});
	return [
		{
			name: "jev_triage",
			label: "Jev triage",
			description: TRIAGE_DESCRIPTION,
			parameters: z.object({
				request: z.string(),
				topics: z.array(z.string()).optional(),
				evidence: evidence.optional(),
			}),
			example: {
				request: "Add a --dry-run flag to the export command and update its usage text.",
				topics: ["export CLI flag", "usage text"],
				evidence: [{ kind: "user", quote: "Add a --dry-run flag to the export command" }],
			},
		},
		{
			name: "jev_requirements",
			label: "Jev requirements",
			description: REQUIREMENTS_DESCRIPTION,
			parameters: z.object({
				request: z.string(),
				items: z.array(z.object({ text: z.string(), source: z.string() })),
				candidateNeeds: z.array(z.string()).optional(),
				evidence: evidence.optional(),
			}),
			example: {
				request: "Add a --dry-run flag to the export command and update its usage text.",
				items: [
					{
						text: "The export command accepts --dry-run and reports what it would write without writing it.",
						source: "Add a --dry-run flag to the export command",
					},
					{
						text: "The command usage text documents --dry-run.",
						source: "update its usage text",
					},
				],
			},
		},
		{
			name: "jev_plan_review",
			label: "Jev plan review",
			description: PLAN_REVIEW_DESCRIPTION,
			parameters: z.object({
				phase: z.enum(["outline", "detail", "finalize"]),
				steps: z.array(z.object({ id: z.string(), summary: z.string(), requirement: z.string() })).optional(),
				plan: z.string().optional(),
				topic: z
					.object({
						id: z.string(),
						section: z.string(),
						paths: z.array(z.string()),
						requirement: z.string(),
					})
					.optional(),
				evidence,
			}),
			example: {
				phase: "outline",
				steps: [
					{
						id: "s1",
						summary: "Parse --dry-run in the export command and print the planned writes instead of writing.",
						requirement: "The export command accepts --dry-run and reports what it would write without writing it.",
					},
					{
						id: "s2",
						summary: "Document --dry-run in the command usage text.",
						requirement: "The command usage text documents --dry-run.",
					},
				],
				evidence: [{ kind: "user", quote: "Add a --dry-run flag to the export command" }],
			},
		},
		{
			name: "jev_consult",
			label: "Jev consult",
			description: CONSULT_DESCRIPTION,
			parameters: z.object({
				mode: z.enum(["choice", "score", "boolean", "recovery"]),
				question: z.string().optional(),
				context: z.string().optional(),
				evidence: evidence.optional(),
				alternatives: z.array(z.object({ label: z.string(), meaning: z.string() })).optional(),
				criteria: z.array(z.string()).optional(),
				trueMeaning: z.string().optional(),
				falseMeaning: z.string().optional(),
				recovery: recovery.optional(),
			}),
			example: {
				mode: "choice",
				question: "Does the export command report planned writes on stdout or stderr?",
				context: "The existing reporter writes user-facing progress to stderr and machine output to stdout.",
				alternatives: [
					{ label: "stdout", meaning: "dry-run writes go to stdout with the other machine-readable output" },
					{ label: "stderr", meaning: "dry-run writes join the progress messages on stderr" },
				],
				evidence: [{ kind: "code", quote: "process.stderr.write(progress)", source: "src/report.ts" }],
			},
		},
		{
			name: "jev_context",
			label: "Jev context",
			description: CONTEXT_DESCRIPTION,
			parameters: z.object({
				action: z.enum(["list", "read"]),
				sourceId: z.string().optional(),
			}),
			example: { action: "list" },
		},
		{
			name: "jev_course_check",
			label: "Jev course check",
			description: COURSE_CHECK_DESCRIPTION,
			parameters: z.object({
				claim: z.string(),
				nextAction: z.string().optional(),
				evidence: evidence.optional(),
			}),
			example: {
				claim: "The parser change adds --dry-run to the export command as planned.",
				nextAction: "Update the command usage text next.",
				evidence: [{ kind: "code", quote: "if (flags.dryRun) return reportPlannedWrites();", source: "src/export.ts" }],
			},
		},
		{
			name: "jev_acceptance",
			label: "Jev acceptance",
			description: ACCEPTANCE_DESCRIPTION,
			parameters: z.object({
				aspect: z.enum(["business", "architecture"]),
				claim: z.string(),
				evidence,
			}),
			example: {
				aspect: "business",
				claim: "The owner can run the export command with --dry-run and see the planned writes without any file being written.",
				evidence: [
					{ kind: "execution", quote: "bun test: 4 dry-run cases pass", source: "bun test" },
					{
						kind: "code",
						quote: "if (flags.dryRun) return reportPlannedWrites();",
						source: "src/export.ts",
					},
				],
			},
		},
		{
			name: "jev_review",
			label: "Jev developer review",
			description: REVIEW_DESCRIPTION,
			parameters: z.object({
				kind: z.enum(["checkpoint", "commit", "diff"]),
				target: z.string(),
				claim: z.string(),
				evidence,
			}),
			example: {
				kind: "diff",
				target: "src/export.ts",
				claim: "The export command returns planned writes under --dry-run instead of writing files.",
				evidence: [
					{ kind: "code", quote: "if (flags.dryRun) return reportPlannedWrites();", source: "src/export.ts" },
					{ kind: "execution", quote: "bun test: 4 pass", source: "bun test" },
				],
			},
		},
		{
			name: "jev_text_review",
			label: "Jev text review",
			description: TEXT_REVIEW_DESCRIPTION,
			parameters: z.object({
				text: z.string(),
				rules: z.array(z.object({ class: z.string(), rule: z.string(), scope: z.enum(["text", "fragment"]).optional() })),
			}),
			example: {
				text: "The export command now supports --dry-run. Use it to preview planned writes.",
				rules: [
					{
						class: "clarity",
						rule: "Each sentence must name its subject and use the active voice.",
						scope: "text",
					},
				],
			},
		},
		{
			name: "jev_anti_slop",
			label: "Jev anti-slop",
			description: ANTI_SLOP_DESCRIPTION,
			parameters: z.object({
				artifact: z.string(),
				language: z.string(),
				register: z.string(),
				purpose: z.string(),
				audience: z.string(),
				rules: z.array(
					z.object({
						class: z.string(),
						rule: z.string(),
						severity: z.enum(["blocker", "warning"]).optional(),
					}),
				),
				claims: z.array(
					z.object({
						id: z.string(),
						text: z.string(),
						kind: z.enum(["fact", "hypothesis"]),
						evidence: z.array(
							z.object({
								kind: z.string(),
								quote: z.string(),
								source: z.string().optional(),
								sourceClass: z.enum([
									"primary",
									"official",
									"peer_reviewed",
									"reputable_secondary",
									"anonymous",
									"none",
								]),
							}),
						),
						falsifier: z.string().optional(),
					}),
				),
				inferences: z
					.array(
						z.object({
							id: z.string(),
							premises: z.array(z.string()),
							warrant: z.string(),
							conclusion: z.string(),
						}),
					)
					.optional(),
				part: z.object({ index: z.number(), total: z.number() }).optional(),
			}),
			example: {
				artifact: "The export command supports --dry-run as of version 2.2.",
				language: "English",
				register: "technical release note",
				purpose: "announce the new flag",
				audience: "existing users of the export command",
				rules: [{ class: "accuracy", rule: "Every version or behavior claim carries its source." }],
				claims: [
					{
						id: "c1",
						text: "The export command supports --dry-run as of version 2.2.",
						kind: "fact",
						evidence: [
							{
								kind: "code",
								quote: "if (flags.dryRun) return reportPlannedWrites();",
								source: "src/export.ts",
								sourceClass: "primary",
							},
						],
					},
				],
			},
		},
		{
			name: "jev_reaim",
			label: "Jev re-aim",
			description: REAIM_DESCRIPTION,
			parameters: z.object({
				interjection: z.string(),
				evidence,
			}),
			example: {
				interjection: "Stop the export flag work and fix the login redirect instead.",
				evidence: [{ kind: "user", quote: "Stop the export flag work and fix the login redirect instead." }],
			},
		},
		{
			name: "jev_search_relevance",
			label: "Jev search relevance",
			description: SEARCH_DESCRIPTION,
			parameters: z.object({
				query: z.string(),
				candidates: z.array(
					z.object({
						title: z.string().optional(),
						url: z.string().optional(),
						evidence: z.string(),
						reason: z.string(),
					}),
				),
			}),
			example: {
				query: "Does Node report planned writes on stdout or stderr by convention?",
				candidates: [
					{
						title: "Node.js process documentation",
						url: "https://nodejs.org/api/process.html",
						evidence: "process.stdout and process.stderr are separate writable streams.",
						reason: "Confirms the two streams exist but not which one a dry run should use.",
					},
					{
						title: "POSIX utility conventions",
						url: "https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap12.html",
						evidence: "Diagnostic output is written to standard error.",
						reason: "Answers the convention question for machine-readable versus diagnostic output.",
					},
				],
			},
		},
	];
}

/** Concrete `jev_consult` recovery payloads shown in the startup guidance. */
const REPAIR_EXAMPLE = {
	mode: "recovery",
	recovery: {
		findingId: "finding-1a2b3c4d5e6f",
		phase: "repair",
		diagnosis:
			"The export command wrote the file before the dry-run branch could report the planned writes.",
		correction:
			"Apply the same edit with the dry-run branch returning the planned writes before any file write.",
		nextAction: {
			tool: "edit",
			input: {
				path: "src/export.ts",
				old_string: "await writeFile(target, body);",
				new_string:
					"if (flags.dryRun) return reportPlannedWrites(target);\n\t\tawait writeFile(target, body);",
			},
		},
	},
	evidence: [{ kind: "code", quote: "await writeFile(target, body);", source: "src/export.ts" }],
};

const RESOLVE_EXAMPLE = {
	mode: "recovery",
	recovery: {
		findingId: "finding-1a2b3c4d5e6f",
		phase: "resolve",
		diagnosis:
			"The export command wrote files under --dry-run because the write ran before the dry-run branch.",
		correction:
			"The dry-run branch now returns the planned writes before any write, and the focused tests pass.",
	},
	evidence: [
		{ kind: "execution", quote: "bun test src/export.test.ts: 4 pass", source: "bun test src/export.test.ts" },
		{
			kind: "code",
			quote: "if (flags.dryRun) return reportPlannedWrites(target);",
			source: "src/export.ts",
		},
	],
};

const RECOVERY_GUIDANCE = [
	"## Recovery while a finding holds work",
	"",
	"`jev_consult` with `mode: \"recovery\"` is the only call that clears a finding. Write each parameter object below as the `content` value to `path: \"xd://jev_consult\"`. The addon supplies the held finding, the approved plan and requirements and the recent native action observations; read the finding with `jev_context({\"action\":\"list\"})` first, and never infer a cause from a score. `choice`, `score` and `boolean` stay diagnostic while a hold stands: they require `question` and `context`, answer a question, and never clear a finding. Each phase below is judged as one canonical boolean question at the unchanged workflow boolean floor (0.7); a below-floor answer is not approval and clears nothing.",
	"",
	"### Repair one refused action (`phase: \"repair\"`)",
	"",
	"`nextAction` is required for repair and names one native tool (never a `jev_*` tool) with its complete argument object. Approval authorizes only that one exact invocation, under the unchanged finding, task, owner request, requirements, plan and revision; it does not claim the defect is fixed, and every other consequential call stays held. When the refused action never executed, admitting the exact approved replacement retires that action-preflight finding. Repair the actual artifact or action, not the wording of the request. If the cause is unknown, ask a diagnostic `choice` first.",
	"",
	"Device: `write` with `path: \"xd://jev_consult\"` and the object below as `content`.",
	"",
	"```json",
	JSON.stringify(REPAIR_EXAMPLE, null, 2),
	"```",
	"",
	"### Resolve the finding with observed proof (`phase: \"resolve\"`)",
	"",
	"`resolve` takes no `nextAction` and requires the diagnosis, the correction and nonempty quoted evidence. It clears only the named finding, and only the submitted proof establishes the correction. Requirements or plan reviews and a resubmission of the same failed judged activity remain callable while a hold stands; those calls alone do not authorize project effects. An owner override is an exceptional owner decision, never the next step the addon asks for.",
	"",
	"Device: `write` with `path: \"xd://jev_consult\"` and the object below as `content`.",
	"",
	"```json",
	JSON.stringify(RESOLVE_EXAMPLE, null, 2),
	"```",
	"",
	"Duplicate recovery is recognized by phase, the exact action, the bindings and the evidence, not by reworded prose; a refused recovery with unchanged material buys no new judge call. The result, the observable reason and one next action come back concisely, and the original finding stays under `hold`.",
].join("\n");

/**
 * The startup documentation of the same entries. Registration and this text read one array, so a
 * registered tool can never be missing here or described with a stale schema.
 */
export function toolInstructions(catalog: readonly ToolCatalogEntry[]): string {
	const sections = catalog.map(entry =>
		[
			`### \`${entry.name}\` - ${entry.label}`,
			"",
			entry.description,
			`Device: \`xd://${entry.name}\`. The JSON below is the raw parameter object, which is the \`content\` value for \`write\` with that path. Do not invoke Jev tools through \`eval\` or \`tool.${entry.name}\`: that wrapper is opaque to the gates.`,
			"",
			"```json",
			JSON.stringify(entry.example, null, 2),
			"```",
		].join("\n"),
	);
	return [
		"## Owner mode precedence",
		"",
		"`/jev off`, `/jev on` and the other `/jev...` commands are native owner commands, not tools: no model text and no tool argument can invoke them or switch modes. An owner `/jev off` suspends this entire manual and catalog for the session until `/jev on`, and `/jev on` starts a fresh workflow without restoring earlier approvals, findings or continuation grants. Treat the addon's steering message as the current mode; cached instructions here never outrank it.",
		"",
		"## Tool catalog",
		"",
		"Every registered Jev tool is below with its purpose, the guide to its accepted arguments and one call that is valid as written. Optional fields are named in the argument guide; the example shows the common shape. Required fields are never omitted, and a tool is never called to discover its parameters.",
		"",
		...sections,
		"",
		RECOVERY_GUIDANCE,
	].join("\n");
}
