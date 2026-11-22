/**
 * The one canonical tool catalog: registration reads it and the startup prompt is derived from it.
 *
 * Every entry carries the registered purpose, the guide to its accepted arguments (including the
 * optional fields its example does not show) and one call that is valid as written. A description
 * here is the only place a tool is documented, so a changed schema and a changed guide cannot drift
 * apart. The module imports schema types only; it never imports controller runtime.
 */
import type { SchemaBuilder } from "./controller.js";
import { ANTI_SLOP_PROTOCOL_GUIDANCE } from "./antiSlopProtocol.js";

/** One registered tool, before its executor is attached. */
export interface ToolCatalogEntry {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	example: Record<string, unknown>;
}

const CONSULT_DESCRIPTION =
	"Use one diagnostic decision to settle what the code and the owner request do not. Arguments: mode (required: choice, score or boolean); question (one decision) and context (the state the decision rests on - the judge sees only what you submit here and in evidence) plus alternatives (choice: two or more {label, meaning}, each naming what choosing it commits to), criteria (score: two or more ordered rubric steps) or trueMeaning and falseMeaning (boolean: what yes and what no commit to). Optional evidence carries quoted {kind, quote, source?, sourceId?} items. Every mode is diagnostic: it answers one question and grants no approval, permission or execution authority. A recorded finding is a diagnostic record; a consultation neither clears it nor blocks a call, and a below-floor or inconclusive answer is simply not approval. Use it to understand a cause before improving the work, never as a request to be unblocked.";

const TRIAGE_DESCRIPTION =
	"Submit the owner's request once, before project inspection for a judged change and before any consequential change. Arguments: request (required: the owner's exact words); topics (optional: one narrow topic per concrete area); evidence (optional: exact {kind, quote, source?, sourceId?} items). Development requires requirements and staged plan review; simple names the skipped stages; unsettled registers nothing. A read, search or summary task needs no triage and no tool ritual. Public HTTP(S) URL reads are external evidence. Project reads are never blocked, but a judged change is only recorded as reviewed after triage. Skill reads and task tracking remain available. Recognized literal read and search commands, including safe pipelines, are classified without judgment. Unknown wrappers, executable scripts, delegation and unsupported shell syntax are classified as consequential and judged on their actual payload when they run. Triage also records whether the deliverable is external-facing. Do not re-triage to escape a refusal; refine the material instead.";

const REAIM_DESCRIPTION =
	"Use only when the owner actually replaces the task direction. Arguments: interjection (required: the owner's words verbatim); evidence (required: at least the same owner text as a {kind: \"user\", quote, sourceId?} item, where a sourceId from jev_context binds it to the recorded message). A clarification, an addition or a follow-up is not a re-aim and is handled through the owner-update path; do not use this tool to escape a refusal or to restore an old direction. Approval drops prior approvals and requires fresh requirements and plan review - no re-triage.";

const SEARCH_DESCRIPTION =
	"Submit one search question with its candidates. Arguments: query (required); candidates (required: two or more {title?, url?, evidence (the exact excerpt), reason (why it answers the query, or why it does not)}). Jev selects a candidate or none; the reason is yours, not Jev's. A below-floor selection is unusable; resubmit only with different candidates or excerpts.";

const FACT_CHECK_DESCRIPTION =
	"Check research before delivery or verify text on request. Submit artifact (the exact text) and claims [{quote (verbatim draft fragment), statement (one self-contained factual assertion preserving scope), evidence [{source (exact path or URL passed to read, command passed to bash, or 'owner'), quote (verbatim excerpt)}]}]. Open the source; a search snippet is only a lead. For table claims, include the matching row, headings, units, conditions and caption, or quote the result in unambiguous source prose. Include every factual assertion, including implied premises, and cite contrary evidence. Use an empty evidence array when no evidence is available, and an empty claims array only for text without assertions. The tool reports factuality separately from relevance and goal coverage. Follow each claim's action: reopen the source, add context, correct a contradiction, or leave a low-confidence result unresolved. Recheck changed claims and disclose unresolved findings; the review never blocks delivery.";

const REQUIREMENTS_DESCRIPTION =
	"Check derived obligations against the owner's objective. In ordinary work omit request to use the exact captured objective; an explicit request must match it. Supervised work requires the exact request. Supply items (one {text: a checkable obligation, source: a short exact quote from the request}); candidateNeeds and evidence with optional sourceId are optional. A diagnostic does not block work; resubmit only when the list materially changes.";

const PLAN_REVIEW_DESCRIPTION =
	"Staged approval of one plan artifact. Arguments: phase (required: outline, detail or finalize); steps (required for outline: one {id, summary, requirement} per high-level step, each requirement exactly matching one approved obligation); plan (required for detail and finalize: the local:// artifact URL); topic (required for detail: {id, section (the exact heading or the complete section), paths, requirement}); evidence (required: quoted {kind, quote, source?, sourceId?} items - for detail, the step's complete artifact section verbatim). Order is outline, then one detail call per step, then finalize. Passing steps are retained while rejected steps are revised; the original request, approved requirements, full outline and earlier approved details are re-sent with every call. No project file change is blocked by this review; a change made before final approval is simply recorded as not yet reviewed, and a changed artifact reopens the affected steps.";

const ACCEPTANCE_DESCRIPTION =
	"Use {\"aspect\":\"outcome\"} at a verified checkpoint or before reporting ordinary project work. With a registered plan, Jev reports a verdict and evidence for each task and reviews the integrated change only after every task passes on the same revision. Both levels suggest evidence-backed removals. Without a plan, it compares approved requirements with recorded changes and execution. No claim or evidence argument is needed for outcome. Optional business and architecture acceptance use a claim and quoted execution and code evidence. No check requires owner approval or blocks ordinary work.";

const REVIEW_DESCRIPTION =
	"Submit one developer review. Arguments: kind (required: checkpoint, commit or diff); target (required: the file or revision reviewed); claim (required: what the change does); evidence (required: changed-code evidence and verification output, each {kind, quote, source?, sourceId?}). A defect finding is a diagnostic record that blocks no work; disclose it and correct the quoted change. This review never replaces business or architecture acceptance.";

const TEXT_REVIEW_DESCRIPTION =
	"Judge prose against explicit rules. Arguments: text (required: the exact text to judge); rules (required: {class, rule, scope?} items, where scope=text judges the whole text once and is the default, scope=fragment judges each prose fragment, and headings and table blocks are never fragments). Submit the exact rules; revise only the returned violating fragments. No returned defect means the text meets the submitted rules.";

const ANTI_SLOP_DESCRIPTION =
	"Use before delivering an external document, research output, legal or other external communication, including a new tracker issue. Arguments: artifact (required: the exact text), language, register, purpose, audience (all required), rules (required array of {class, rule, severity?: blocker|warning}; use [] for built-in Russian or English checks alone; other languages need explicit rules), claims (required array of {id, text, kind: fact|hypothesis, evidence [{kind, quote, source?, sourceClass}], falsifier?}; use [] only for text without factual assertions; a hypothesis needs a falsifier), inferences (optional: {id, premises, warrant, conclusion}), part (optional: {index, total} for numbered parts). Russian and English automatically receive independent symbols, wording, syntax and coherence checks in addition to supplied rules. Findings identify severity, quote the affected sentence when localized reliably or the enclosing paragraph otherwise, and specify a repair; the executor edits the text, not the tool. Use severity blocker for an explicit mandatory rule and warning for editorial preferences. If scope or configuration skips the review, the result gives the reason. Unlisted claims are not fact-checked. An inconclusive or unavailable result is not clean. Report findings and incomplete checks without repeating unchanged submissions to seek approval. All findings are diagnostic and never block execution or delivery.\n\n" +
	"In ordinary sessions, open factual sources first so their exact quotes can be verified. A current fact-check may be reused for the exact assertion and draft. For multipart submissions, set part.documentDigest to the lower-case SHA-256 of all exact part texts concatenated in index order, with no inserted separator.\n\n" +
	ANTI_SLOP_PROTOCOL_GUIDANCE;

const CONTEXT_DESCRIPTION =
	"Read trusted archived sources and ordinary session diagnostic results. action: list shows sources, recent results and the latest finding. action: read takes the archive sourceId and returns exact archived content and its digest. action: result takes a displayed result ID in sourceId and returns its input, verdict, provenance, linked prior results and current or historical status. Use archived evidence as {kind,quote,sourceId}, with kind user for owner text. Provenance is not factual truth or authority. Reading never restores approval or permission.";

const COURSE_CHECK_DESCRIPTION =
	"Check manually whether current work follows the approved task. Arguments: claim (required: one concise statement of the current work); nextAction (optional: what you intend to do next); evidence (optional: quoted {kind, quote, source?, sourceId?} items). The check evaluates the claim and proposed action against the approved objective, requirements, plan and recent observed actions, and works before any recent action once a plan exists. No plan or insufficient context returns a named prerequisite, not a clean result. A below-floor on_course is no reliable approval and not a proven deviation; only off_course establishes one. An unsupported, off-course or unavailable verdict records a diagnostic finding; an approving check neither erases another finding nor authorizes a file change, nor replaces acceptance. Findings never block execution or completion. Automatic interval and completion checks still run on their own.";

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
				request: z.string().optional(),
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
				mode: z.enum(["choice", "score", "boolean"]),
				question: z.string().optional(),
				context: z.string().optional(),
				evidence: evidence.optional(),
				alternatives: z.array(z.object({ label: z.string(), meaning: z.string() })).optional(),
				criteria: z.array(z.string()).optional(),
				trueMeaning: z.string().optional(),
				falseMeaning: z.string().optional(),
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
			description: CONTEXT_DESCRIPTION + " Ordinary list includes diagnostic result IDs and their applicability. Use action=result with sourceId set to a result ID to inspect the exact submission and result.",
			parameters: z.object({
				action: z.enum(["list", "read", "result"]),
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
				aspect: z.enum(["outcome", "business", "architecture"]),
				claim: z.string().optional(),
				evidence: evidence.optional(),
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
				part: z.object({ index: z.number(), total: z.number(), documentDigest: z.string().optional() }).optional(),
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
			name: "jev_fact_check",
			label: "Jev fact-check",
			description: FACT_CHECK_DESCRIPTION,
			parameters: z.object({
				artifact: z.string(),
				claims: z.array(z.object({
					quote: z.string(),
					statement: z.string(),
					evidence: z.array(z.object({ source: z.string(), quote: z.string() })),
				})),
			}),
			example: {
				artifact: "The survey included 72 respondents.",
				claims: [{
					quote: "The survey included 72 respondents.",
					statement: "The survey included 72 respondents.",
					evidence: [{ source: "survey/methods.md", quote: "Seventy-two participants submitted responses." }],
				}],
			},
		},
		{
			name: "jev_issue",
			label: "Jev issue",
			description: "Optional two-sided repository issue workflow. Author: prepare checks the observed issue inventory {target,query,issues:[{url,title,body}]} for duplicates, and separates reproduction, observed and expected behavior, diagnosis and proposed fixes. After exact authorization, publish via gh or glab and verify the observed same-target readback. For any filed issue phase, run `gh api --hostname HOST repos/OWNER/REPO/issues/NUMBER` or `glab api --hostname HOST projects/URL_ENCODED_PROJECT/issues/NUMBER`; use the exact command as readback.source. Developer: understand reviews exact material segments and emits obligation IDs; use scope for a narrower outcome. develop takes the understand result ID as priorResult and steps that map each obligation to a proposed change or verification, exact bash command, expected observation and counterexample. accept takes the develop result ID as priorResult and checks the implementation and terminal results recorded by OMP after the last edit. Use matching issue bytes in each phase. The tool does not publish, implement or close issues and grants no permission.",
			parameters: z.object({
				phase: z.enum(["prepare", "verify", "understand", "develop", "accept"]),
				target: z.object({ platform: z.enum(["github", "gitlab"]), host: z.string(), destination: z.string() }),
				title: z.string(),
				body: z.string(),
				inventory: z.object({ source: z.string(), quote: z.string() }).optional(),
				readback: z.object({ source: z.string(), quote: z.string().optional() }).optional(),
				priorResult: z.string().optional(),
				fields: z.array(z.object({
					kind: z.enum(["observation", "expected", "reproduction", "hypothesis", "remedy"]),
					quote: z.string(),
					evidence: z.array(z.object({ source: z.string(), quote: z.string() })).optional(),
				})).optional(),
				segments: z.array(z.object({
					kind: z.enum(["observation", "expected", "reproduction", "hypothesis", "remedy", "acceptance"]),
					quote: z.string(),
					disposition: z.enum(["accept", "narrow", "already_satisfied", "disagree", "unresolved"]),
					basis: z.string(),
					scope: z.string().optional(),
					origin: z.object({ source: z.string(), quote: z.string() }).optional(),
					evidence: z.array(z.object({ source: z.string(), quote: z.string() })).optional(),
				})).optional(),
				steps: z.array(z.object({
					segment: z.string(),
					change: z.string(),
					command: z.string(),
					expected: z.string(),
					rejects: z.string(),
					evidence: z.array(z.object({ source: z.string(), quote: z.string() })).optional(),
				})).optional(),
			}),
			example: {
				phase: "verify",
				target: { platform: "github", host: "github.com", destination: "acme/export" },
				title: "Dry-run writes files",
				body: "Running `export --dry-run` created an output file.",
				readback: { source: "gh api --hostname github.com repos/acme/export/issues/12" },
			},
		},
		{
			name: "jev_todo",
			label: "Jev TODO",
			description: "Optional project backlog diagnostic after planning. Read the whole file with the native read tool (for example TODO.md:raw), then pass {action,source,threshold?,artifact?}. The tool uses the observed bytes; do not copy the file into the call. A version 1 JSON object lives in a jev-todo-v1 Markdown fence or standalone JSON. It has plan {source,quote}, requirements [{id,source,quote}], and epics [{id,tasks,archived?}]. Tasks have {id,result,requirements,needs?,check?,inputs?,question?,report?}. A need names {id,output,when?:verified|reported}; a check names {procedure,wrongResult,existing?}. Inputs quote whole current reads. A report names {kind:verified|blocked,fingerprint,procedure,observation:{source,quote}}. Reread persisted check output on resumption; it must include the exact `jev-todo-v1 <task-id> <fingerprint> <kind>` line and actual output. Review separates necessity, usefulness of checks, dependencies and coverage. Resume selects ready work and distinguishes stale and missing evidence. Cleanup only proposes a change when an explicit owner threshold is reached; no default and no file writes.",
			parameters: z.object({
				action: z.enum(["review", "resume", "cleanup"]),
				source: z.string(),
				artifact: z.string().optional(),
				threshold: z.number().optional(),
			}),
			example: {
				action: "resume",
				source: "TODO.md:raw",
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
			"Call this tool directly with the JSON arguments below.",
			"",
			"```json",
			JSON.stringify(entry.example, null, 2),
			"```",
		].join("\n"),
	);
	return [
		"## Owner mode precedence",
		"",
		"`/jev off`, `/jev on` and the other `/jev...` commands are native owner commands, not tools: no model text and no tool argument can invoke them or switch modes. An owner `/jev off` suspends this entire manual and catalog for the session until `/jev on`, and `/jev on` starts a fresh workflow without restoring earlier approvals or findings. Treat the addon's steering message as the current mode; cached instructions here never outrank it.",
		"",
		"## Tool catalog",
		"",
		"Every registered Jev tool is below with its purpose, the guide to its accepted arguments and one call that is valid as written. Optional fields are named in the argument guide; the example shows the common shape. Required fields are never omitted, and a tool is never called to discover its parameters.",
		"",
		...sections,
	].join("\n");
}
