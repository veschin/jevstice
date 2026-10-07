/**
 * Canonical runtime guards for the jev package (single definition; import, do not recreate).
 */

/** Narrow unknown to a non-null, non-array object with unknown fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty, non-whitespace string. */
export function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
