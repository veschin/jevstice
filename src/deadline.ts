/**
 * Internal consult deadlines.
 *
 * Every judge consult the controller runs inside a host handler is bounded by the host's own
 * handler timeout. The bounds differ per event (omp 18.6.3 runner.ts): a `tool_call` handler
 * that times out is treated FAIL-CLOSED (`{ block: true }`), a `before_subagent_spawn` handler
 * that times out is dropped and the spawn proceeds. A gate must therefore decide BEFORE the
 * host does, and take its own conservative path: the deadline fires first and returns
 * `undefined`, and a late answer is never read (a verdict landing after the deadline must not
 * pin a refusal that the host already ignored).
 *
 * `HOST_HANDLER_TIMEOUT_MS` is the host ceiling every descriptor deadline must stay under; the
 * gate/review registry is validated against it.
 */

/** The host's extension-handler ceiling (runner.ts EXTENSION_HANDLER_TIMEOUT_MS). */
export const HOST_HANDLER_TIMEOUT_MS = 30_000;

/**
 * Race `work` against an internal deadline. `deadlineMs` undefined means there is no host
 * ceiling to beat (a background consult): the work is awaited as-is. Returns undefined when the
 * deadline wins, so the caller records uncertainty instead of reading a late answer.
 */
export async function withDeadline<T>(work: Promise<T>, deadlineMs: number | undefined): Promise<T | undefined> {
	if (deadlineMs === undefined) return await work;
	let timer: Timer | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<undefined>(resolve => {
				timer = setTimeout(() => resolve(undefined), deadlineMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
