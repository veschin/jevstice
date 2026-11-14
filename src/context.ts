/**
 * Project-local archive of trusted context: authentic owner messages, requirement snapshots and
 * approved plan bytes.
 *
 * Records live under `<cwd>/.omp/jev/context` as immutable JSON files named by a content-addressed
 * identifier. The identifier binds the exact content digest and the provenance metadata, and every
 * `read`/`list` re-verifies both, so a modified, renamed or malformed record is reported instead of
 * being trusted. Provenance authenticates where a message or snapshot came from; it never restores
 * workflow approvals, permissions or execution authority.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** One archived trusted source. */
export interface ContextSource {
	id: string;
	kind: "owner" | "requirements" | "plan";
	sessionId: string;
	content: string;
	digest: string;
	origin: "interactive" | "rpc" | "prompt" | "judge_approved";
	source?: string;
	approval?: string;
	sequence?: number;
}

/** The immutable, integrity-checked source archive for one project directory. */
export interface ContextArchive {
	put(input: Omit<ContextSource, "id" | "digest">): ContextSource;
	list(): ContextSource[];
	read(id: string): ContextSource;
}

interface StoredRecord extends ContextSource {
	version: 1;
}

type RecordIdentity = Pick<ContextSource, "kind" | "sessionId" | "origin" | "digest" | "source" | "approval" | "sequence">;

const RECORD_VERSION = 1;
const RECORD_SUFFIX = ".json";
const ARCHIVE_SEGMENTS = [".omp", "jev", "context"] as const;
const HEX_ID = /^[0-9a-f]{64}$/;
const RECORD_KEYS: Record<string, true> = {
	version: true,
	id: true,
	kind: true,
	sessionId: true,
	content: true,
	digest: true,
	origin: true,
	source: true,
	approval: true,
	sequence: true,
};
const REQUIRED_KEYS = ["version", "id", "kind", "sessionId", "content", "digest", "origin"] as const;
const INPUT_KEYS: Record<string, true> = {
	kind: true,
	sessionId: true,
	content: true,
	origin: true,
	source: true,
	approval: true,
	sequence: true,
};

function fail(message: string): never {
	throw new Error(message);
}

const errorCode = (error: unknown): string | undefined => {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = error.code;
	return typeof code === "string" ? code : undefined;
};

const failWith = (action: string, path: string, error: unknown): never => {
	const code = errorCode(error);
	const detail = error instanceof Error ? error.message : String(error);
	throw new Error(`cannot ${action} ${path}: ${code ?? detail}`);
};

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const isKind = (value: unknown): value is ContextSource["kind"] => value === "owner" || value === "requirements" || value === "plan";
const isOrigin = (value: unknown): value is ContextSource["origin"] => value === "interactive" || value === "rpc" || value === "prompt" || value === "judge_approved";
const isSequence = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The record identifier binds content (through the digest) and the complete provenance metadata. */
const recordId = (identity: RecordIdentity): string => {
	const metadata: Record<string, unknown> = {
		version: RECORD_VERSION,
		kind: identity.kind,
		sessionId: identity.sessionId,
		origin: identity.origin,
		digest: identity.digest,
	};
	if (identity.source !== undefined) metadata.source = identity.source;
	if (identity.approval !== undefined) metadata.approval = identity.approval;
	if (identity.sequence !== undefined) metadata.sequence = identity.sequence;
	return sha256(JSON.stringify(metadata));
};

const lstatOrNull = (path: string): Stats | null => {
	try {
		return lstatSync(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		return failWith("inspect", path, error);
	}
};

const realpathOf = (path: string): string => {
	try {
		return realpathSync(path);
	} catch (error) {
		return failWith("resolve", path, error);
	}
};

const createDirectory = (path: string): void => {
	try {
		mkdirSync(path);
	} catch (error) {
		return failWith("create", path, error);
	}
};

/**
 * Walk the archive segments below the project directory, refusing a symlink or non-directory at any
 * level, creating missing levels only when asked. Returns null when the archive is absent and
 * creation is not requested.
 */
const resolveArchive = (root: string, create: boolean): string | null => {
	let current = root;
	for (const segment of ARCHIVE_SEGMENTS) {
		current = join(current, segment);
		const stat = lstatOrNull(current);
		if (stat === null) {
			if (!create) return null;
			createDirectory(current);
			continue;
		}
		if (stat.isSymbolicLink()) fail(`refusing archive path ${current}: it is a symbolic link`);
		if (!stat.isDirectory()) fail(`refusing archive path ${current}: it is not a directory`);
	}
	const relationship = relative(realpathOf(root), realpathOf(current));
	if (relationship === ".." || relationship.startsWith(`..${sep}`) || isAbsolute(relationship)) {
		fail(`refusing archive path ${current}: it resolves outside the project directory ${root}`);
	}
	return current;
};

const toSource = (record: StoredRecord): ContextSource => {
	const source: ContextSource = {
		id: record.id,
		kind: record.kind,
		sessionId: record.sessionId,
		content: record.content,
		digest: record.digest,
		origin: record.origin,
	};
	if (record.source !== undefined) source.source = record.source;
	if (record.approval !== undefined) source.approval = record.approval;
	if (record.sequence !== undefined) source.sequence = record.sequence;
	return source;
};

const optionalText = (parsed: Record<string, unknown>, field: string, id: string): string | undefined => {
	const value = parsed[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) fail(`record ${id} field ${field} must be a non-empty string`);
	return value;
};

const optionalSequence = (parsed: Record<string, unknown>, id: string): number | undefined => {
	const value = parsed["sequence"];
	if (value === undefined) return undefined;
	if (!isSequence(value)) fail(`record ${id} field sequence must be a non-negative safe integer`);
	return value;
};

const parseRecord = (bytes: string, id: string): Record<string, unknown> => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bytes);
	} catch (error) {
		return fail(`record ${id} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail(`record ${id} is not a JSON object`);
	return parsed as Record<string, unknown>;
};

/** Re-derive every identity field from the stored record; any discrepancy is a corrupt entry. */
const verifyRecord = (parsed: Record<string, unknown>, expectedId: string): StoredRecord => {
	for (const key of Object.keys(parsed)) {
		if (RECORD_KEYS[key] !== true) fail(`record ${expectedId} has unknown field ${JSON.stringify(key)}; allowed fields: ${Object.keys(RECORD_KEYS).join(", ")}`);
	}
	for (const key of REQUIRED_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(parsed, key)) fail(`record ${expectedId} is missing required field ${key}`);
	}
	if (parsed.version !== RECORD_VERSION) {
		fail(`record ${expectedId} has version ${JSON.stringify(parsed.version)}; this build reads version ${RECORD_VERSION}`);
	}

	const id = parsed.id;
	if (typeof id !== "string" || !HEX_ID.test(id)) fail(`record ${expectedId} has an invalid id: expected 64 lowercase hex characters`);
	if (id !== expectedId) fail(`record ${id} does not match requested source ${expectedId}`);

	const kind = parsed.kind;
	if (!isKind(kind)) fail(`record ${id} kind is invalid: expected owner, requirements or plan`);
	const origin = parsed.origin;
	if (!isOrigin(origin)) fail(`record ${id} origin is invalid: expected interactive, rpc, prompt or judge_approved`);
	const sessionId = parsed.sessionId;
	if (typeof sessionId !== "string" || sessionId.length === 0) fail(`record ${id} sessionId must be a non-empty string`);
	const content = parsed.content;
	if (typeof content !== "string") fail(`record ${id} content must be a string`);
	const digest = parsed.digest;
	if (typeof digest !== "string" || !HEX_ID.test(digest)) fail(`record ${id} digest must be 64 lowercase hex characters`);
	if (sha256(content) !== digest) fail(`record ${id} content does not match its digest`);

	const record: StoredRecord = { version: RECORD_VERSION, id, kind, sessionId, content, digest, origin };
	const source = optionalText(parsed, "source", id);
	const approval = optionalText(parsed, "approval", id);
	const sequence = optionalSequence(parsed, id);
	if (source !== undefined) record.source = source;
	if (approval !== undefined) record.approval = approval;
	if (sequence !== undefined) record.sequence = sequence;
	if (recordId(record) !== id) fail(`record ${id} metadata does not match its id`);
	return record;
};

const sourceId = (id: unknown): string => {
	if (typeof id !== "string" || !HEX_ID.test(id)) fail(`invalid context source id ${JSON.stringify(id)}: expected 64 lowercase hex characters`);
	return id;
};

const readRecord = (dir: string, id: unknown): { record: StoredRecord; bytes: string } => {
	const key = sourceId(id);
	const path = join(dir, `${key}${RECORD_SUFFIX}`);
	const stat = lstatOrNull(path);
	if (stat === null) fail(`record ${key} is not in the archive`);
	if (stat.isSymbolicLink()) fail(`record ${key} is a symbolic link`);
	if (!stat.isFile()) fail(`record ${key} is not a regular file`);
	let bytes: string;
	try {
		bytes = readFileSync(path, "utf8");
	} catch (error) {
		return failWith("read", path, error);
	}
	return { record: verifyRecord(parseRecord(bytes, key), key), bytes };
};

const readDirectory = (dir: string): string[] => {
	try {
		return readdirSync(dir);
	} catch (error) {
		return failWith("list", dir, error);
	}
};

const validateInput = (input: Omit<ContextSource, "id" | "digest">): void => {
	if (typeof input !== "object" || input === null || Array.isArray(input)) fail("put requires an object describing one context source");
	for (const key of Object.keys(input)) {
		if (INPUT_KEYS[key] !== true) fail(`put input has unexpected field ${JSON.stringify(key)}; allowed fields: ${Object.keys(INPUT_KEYS).join(", ")}`);
	}
	if (!isKind(input.kind)) fail("put input kind is invalid: expected owner, requirements or plan");
	if (!isOrigin(input.origin)) fail("put input origin is invalid: expected interactive, rpc, prompt or judge_approved");
	if (typeof input.sessionId !== "string" || input.sessionId.length === 0) fail("put input sessionId must be a non-empty string");
	if (typeof input.content !== "string") fail("put input content must be a string");
	if (input.source !== undefined && (typeof input.source !== "string" || input.source.length === 0)) fail("put input source must be a non-empty string");
	if (input.approval !== undefined && (typeof input.approval !== "string" || input.approval.length === 0)) fail("put input approval must be a non-empty string");
	if (input.sequence !== undefined && !isSequence(input.sequence)) fail("put input sequence must be a non-negative safe integer");
};

const buildRecord = (input: Omit<ContextSource, "id" | "digest">): StoredRecord => {
	validateInput(input);
	const digest = sha256(input.content);
	const id = recordId({
		kind: input.kind,
		sessionId: input.sessionId,
		origin: input.origin,
		digest,
		source: input.source,
		approval: input.approval,
		sequence: input.sequence,
	});
	const record: StoredRecord = {
		version: RECORD_VERSION,
		id,
		kind: input.kind,
		sessionId: input.sessionId,
		content: input.content,
		digest,
		origin: input.origin,
	};
	if (input.source !== undefined) record.source = input.source;
	if (input.approval !== undefined) record.approval = input.approval;
	if (input.sequence !== undefined) record.sequence = input.sequence;
	return record;
};

/** Per-session chronological order: sessionId, then sequence, then id; unsequenced records last. */
const compareRecords = (left: StoredRecord, right: StoredRecord): number => {
	if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1;
	if (left.sequence !== undefined && right.sequence !== undefined) {
		return left.sequence === right.sequence ? compareIds(left, right) : left.sequence - right.sequence;
	}
	if (left.sequence !== undefined) return -1;
	if (right.sequence !== undefined) return 1;
	return compareIds(left, right);
};

const compareIds = (left: StoredRecord, right: StoredRecord): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/** Create the archive rooted at `cwd`; all operations are synchronous and fail with an explicit Error. */
export const createContextArchive = (cwd: string): ContextArchive => {
	const root = resolve(cwd);
	const put = (input: Omit<ContextSource, "id" | "digest">): ContextSource => {
		const record = buildRecord(input);
		const dir = resolveArchive(root, true);
		if (dir === null) fail(`archive directory under ${root} is unavailable`);
		const path = join(dir, `${record.id}${RECORD_SUFFIX}`);
		const bytes = JSON.stringify(record);
		try {
			writeFileSync(path, bytes, { encoding: "utf8", flag: "wx" });
		} catch (error) {
			if (errorCode(error) !== "EEXIST") failWith("write", path, error);
			const existing = readRecord(dir, record.id);
			if (existing.bytes !== bytes) fail(`record ${record.id} already exists with different bytes`);
			return toSource(existing.record);
		}
		return toSource(record);
	};
	const list = (): ContextSource[] => {
		const dir = resolveArchive(root, false);
		if (dir === null) return [];
		const records = readDirectory(dir).map((name) => {
			if (!name.endsWith(RECORD_SUFFIX)) fail(`archive entry ${JSON.stringify(name)} is not a context record: expected <64 lowercase hex>${RECORD_SUFFIX}`);
			return readRecord(dir, name.slice(0, -RECORD_SUFFIX.length)).record;
		});
		return records.sort(compareRecords).map(toSource);
	};
	const read = (id: string): ContextSource => {
		const key = sourceId(id);
		const dir = resolveArchive(root, false);
		if (dir === null) fail(`record ${key} is not in the archive`);
		return toSource(readRecord(dir, key).record);
	};
	return { put, list, read };
};
