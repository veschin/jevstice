/**
 * The free reading of one request (FR-30): before a single judge call is spent, the extension decides
 * whether this request has to enter the judged workflow at all.
 *
 * The screen is lexical and deterministic - it reads the request text, never the project - so it is
 * deliberately one-sided. Only a request that asks to publish, inspect or verify existing work is
 * read as `quiet`; anything that names a change to the project, and every request this file does not
 * recognise, is read as `judged`. The two mistakes do not cost the same: a wrong `judged` spends one
 * triage call and the judge itself then answers "simple task", while a wrong `quiet` would run real
 * development unjudged and silently. Unknown text therefore always pays.
 *
 * The screen decides entry only. Once a request has entered the workflow (triage registered a
 * development task), this reading no longer overrides it, and the judge - not this file - decides
 * how deep the request goes.
 *
 * The lexicon covers the English and Russian phrasing the owner actually writes, and it is
 * deliberately narrow: a request in a language this file does not know matches nothing and is read
 * as `judged`, which costs one triage call rather than passing real work unjudged.
 */

/** How the extension read a request before spending any judge call. */
export type RequestWeight = "quiet" | "judged";

/** What the request asks for: publishing, inspecting or verifying work that already exists. */
const ROUTINE =
	/\b(?:commit|push|tag|rebase|merge|revert|status|diff|log|show|explain|describe|summari[sz]e|read|find|search|where|what|how|why|review|tests?|lint|typecheck|tsc|benchmark|run|check)\w*\b|(?:коммит|закоммит|пуш|запуш|тег|перебазир|мердж|покаж|показат|посмотр|объясн|расскаж|как работает|где |что тут|что там|найд|поищ|прочита|тест|линт|тип(?:ы|ов)|сборк|запусти|прогони|проверь|проверить|просто проверь)/iu;

/** What the request changes: these words beat every routine signal, wherever they appear. */
const CHANGE =
	/\b(?:implement|add|bug|improv|creat|delet|extract|featur|fix|generat|implement|integrat|migrat|move|rename|refactor|remov|rewrit|split|support|updat|upgrad|writ)\w*\b|(?:добав|реализ|почин|исправ|поправ|правк|фикс|созда|напиш|перепиш|передела|доработ|улучш|обнов|удал|перенес|перенест|перемест|вынес|раздели|поддерж|внедр|миграц|рефактор|докрут|додел|фич)/iu;

/**
 * The screen's verdict for one request. An empty or unrecognised request is `judged`: the judge is
 * the one that decides depth, and this file only decides whether asking is worth anything.
 */
export function weightOf(request: string): RequestWeight {
	const text = request.trim();
	if (text.length === 0) return "judged";
	if (CHANGE.test(text)) return "judged";
	return ROUTINE.test(text) ? "quiet" : "judged";
}
