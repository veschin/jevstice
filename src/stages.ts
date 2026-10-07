/** Canonical decision-stage key set shared by controller and config validation. */
export const STAGES: ReadonlySet<string> = new Set([
	"task_classification",
	"skill_routing",
	"model_routing",
	"topic_selection",
	"understanding_review",
	"direction_review",
	"completion_review",
	"important_decision",
	"code_review",
	"subagent_handoff",
	"refactor_check",
]);
