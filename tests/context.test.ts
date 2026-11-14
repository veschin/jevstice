import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createContextArchive } from "../src/context.js";
import type { ContextArchive, ContextSource } from "../src/context.js";

const ownerInput = {
	kind: "owner" as const,
	sessionId: "session-1",
	content: "owner text",
	origin: "interactive" as const,
};

const withArchive = async (run: (cwd: string, archive: ContextArchive) => Promise<void>): Promise<void> => {
	const cwd = await mkdtemp(join(tmpdir(), "jev-context-"));
	try {
		await run(cwd, createContextArchive(cwd));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
};

const withOutside = async (run: (outside: string) => Promise<void>): Promise<void> => {
	const outside = await mkdtemp(join(tmpdir(), "jev-context-outside-"));
	try {
		await run(outside);
	} finally {
		await rm(outside, { recursive: true, force: true });
	}
};

const recordPath = (cwd: string, id: string): string => join(cwd, ".omp", "jev", "context", `${id}.json`);

const tamper = async (cwd: string, id: string, change: (parsed: Record<string, unknown>) => void): Promise<void> => {
	const path = recordPath(cwd, id);
	const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	change(parsed);
	await writeFile(path, JSON.stringify(parsed), "utf8");
};

describe("T7.1 - storing and reloading trusted sources (s7)", () => {
	test("put then read and list reload the exact bytes", () =>
		withArchive(async (cwd, archive) => {
			const content = "owner line\r\nunicode: привет 🌟\n\ttabbed";
			const stored = archive.put({ ...ownerInput, content, sequence: 1 });

			expect(stored.id).toMatch(/^[0-9a-f]{64}$/);
			expect(stored.digest).toMatch(/^[0-9a-f]{64}$/);
			expect(existsSync(recordPath(cwd, stored.id))).toBe(true);

			const reloaded = createContextArchive(cwd);
			expect(reloaded.read(stored.id).content).toBe(content);
			expect(reloaded.list().map((source) => source.content)).toEqual([content]);

			const parsed = JSON.parse(await readFile(recordPath(cwd, stored.id), "utf8")) as Record<string, unknown>;
			expect(parsed.content).toBe(content);
			expect(parsed.digest).toBe(stored.digest);
		}));

	test("ids and digests are stable across archive instances", () =>
		withArchive(async (cwd, archive) => {
			const first = archive.put({ ...ownerInput, content: "stable", sequence: 7 });
			const second = createContextArchive(cwd).put({ ...ownerInput, content: "stable", sequence: 7 });

			expect(second).toEqual(first);
		}));

	test("repeating identical owner text with distinct sequence stores distinct records", () =>
		withArchive(async (_cwd, archive) => {
			const first = archive.put({ ...ownerInput, content: "same text", sequence: 2 });
			const second = archive.put({ ...ownerInput, content: "same text", sequence: 1 });

			expect(first.id).not.toBe(second.id);
			expect(archive.list().map((source) => source.sequence)).toEqual([1, 2]);
		}));

	test("list is deterministic per-session chronological order", () =>
		withArchive(async (cwd, archive) => {
			archive.put({ ...ownerInput, sessionId: "session-b", content: "b2", sequence: 2 });
			archive.put({ ...ownerInput, sessionId: "session-a", content: "a5", sequence: 5 });
			archive.put({ ...ownerInput, sessionId: "session-b", content: "b1", sequence: 1 });
			archive.put({ ...ownerInput, sessionId: "session-b", content: "b-none", origin: "rpc" });

			const expected = ["a5", "b1", "b2", "b-none"];
			expect(archive.list().map((source) => source.content)).toEqual(expected);
			expect(createContextArchive(cwd).list().map((source) => source.content)).toEqual(expected);
		}));

	test("a missing archive directory lists nothing and a missing record throws", () =>
		withArchive(async (_cwd, archive) => {
			expect(archive.list()).toEqual([]);
			expect(() => archive.read("0".repeat(64))).toThrow(/not in the archive|not stored/);
		}));
});

describe("T7.2 - integrity and immutability (s7)", () => {
	const corruptCases: { name: string; change: (parsed: Record<string, unknown>) => void; message: RegExp }[] = [
		{ name: "content edited in place", change: (parsed) => { parsed.content = "changed"; }, message: /digest|mismatch/i },
		{ name: "session edited", change: (parsed) => { parsed.sessionId = "session-2"; }, message: /id|mismatch/i },
		{ name: "sequence edited", change: (parsed) => { parsed.sequence = 99; }, message: /id|mismatch/i },
		{ name: "unknown extra key", change: (parsed) => { parsed.evil = true; }, message: /unknown field/i },
		{ name: "version changed", change: (parsed) => { parsed.version = 2; }, message: /version/i },
	];

	for (const { name, change, message } of corruptCases) {
		test(`a record with ${name} is rejected on read and list`, () =>
			withArchive(async (cwd, archive) => {
				const stored = archive.put(ownerInput);
				await tamper(cwd, stored.id, change);

				expect(() => archive.read(stored.id)).toThrow(message);
				expect(() => archive.list()).toThrow();
			}));
	}

	test("a renamed record file is rejected instead of accepted under the new id", () =>
		withArchive(async (cwd, archive) => {
			const stored = archive.put(ownerInput);
			const forged = "f".repeat(64);
			await copyFile(recordPath(cwd, stored.id), recordPath(cwd, forged));

			expect(() => archive.list()).toThrow(/does not match|mismatch/i);
			expect(() => archive.read(forged)).toThrow(/does not match|mismatch/i);
		}));

	test("malformed JSON is reported, never skipped", () =>
		withArchive(async (cwd, archive) => {
			const stored = archive.put(ownerInput);
			await writeFile(recordPath(cwd, stored.id), "{ not json", "utf8");

			expect(() => archive.read(stored.id)).toThrow(/valid JSON/i);
			expect(() => archive.list()).toThrow(/valid JSON/i);
		}));

	test("an unrelated entry in the archive directory is reported", () =>
		withArchive(async (cwd, archive) => {
			archive.put(ownerInput);
			await writeFile(join(cwd, ".omp", "jev", "context", "notes.txt"), "x", "utf8");

			expect(() => archive.list()).toThrow(/not a context record/i);
		}));

	test("an identical put is idempotent and never overwrites", () =>
		withArchive(async (cwd, archive) => {
			const first = archive.put({ ...ownerInput, content: "immutable", sequence: 3 });
			const before = await readFile(recordPath(cwd, first.id), "utf8");
			const second = archive.put({ ...ownerInput, content: "immutable", sequence: 3 });
			const after = await readFile(recordPath(cwd, first.id), "utf8");

			expect(second).toEqual(first);
			expect(after).toBe(before);
		}));
});

describe("T7.3 - rejected ids, paths and storage (s7)", () => {
	test("read rejects ids that are not full lowercase sha256 hex", () =>
		withArchive(async (_cwd, archive) => {
			for (const id of ["", "..", "../x", "/etc/passwd", "ABCDEF", "a".repeat(63), "a".repeat(64) + "a"]) {
				expect(() => archive.read(id)).toThrow(/invalid|not a context source id/i);
			}
			expect(() => archive.read(5 as never)).toThrow(/invalid|not a context source id/i);
		}));

	test("a symlinked archive root is refused", () =>
		withArchive(async (cwd, _archive) =>
			withOutside(async (outside) => {
				await mkdir(join(cwd, ".omp", "jev"), { recursive: true });
				await symlink(outside, join(cwd, ".omp", "jev", "context"));
				const archive = createContextArchive(cwd);

				expect(() => archive.put(ownerInput)).toThrow(/symbolic link/i);
				expect(() => archive.list()).toThrow(/symbolic link/i);
				expect(await readdir(outside)).toEqual([]);
			})));

	test("a symlinked .omp ancestor is refused", () =>
		withArchive(async (cwd, _archive) =>
			withOutside(async (outside) => {
				await symlink(outside, join(cwd, ".omp"));
				const archive = createContextArchive(cwd);

				expect(() => archive.put(ownerInput)).toThrow(/symbolic link/i);
				expect(() => archive.list()).toThrow(/symbolic link/i);
				expect(await readdir(outside)).toEqual([]);
			})));

	test("a symlinked .omp/jev ancestor is refused", () =>
		withArchive(async (cwd, _archive) =>
			withOutside(async (outside) => {
				await mkdir(join(cwd, ".omp"), { recursive: true });
				await symlink(outside, join(cwd, ".omp", "jev"));
				const archive = createContextArchive(cwd);

				expect(() => archive.put(ownerInput)).toThrow(/symbolic link/i);
				expect(() => archive.list()).toThrow(/symbolic link/i);
				expect(await readdir(outside)).toEqual([]);
			})));

	test("a symlinked record is refused", () =>
		withArchive(async (cwd, archive) => {
			const stored = archive.put(ownerInput);
			const target = join(cwd, "outside-record.json");
			await copyFile(recordPath(cwd, stored.id), target);
			await unlink(recordPath(cwd, stored.id));
			await symlink(target, recordPath(cwd, stored.id));

			expect(() => archive.read(stored.id)).toThrow(/symbolic link/i);
			expect(() => archive.list()).toThrow(/symbolic link/i);
		}));

	test("non-directory storage and a missing cwd are explicit errors", () =>
		withArchive(async (cwd) => {
			await writeFile(join(cwd, ".omp"), "not a directory", "utf8");
			const archive = createContextArchive(cwd);

			expect(() => archive.put(ownerInput)).toThrow(/not a directory/i);
			expect(() => archive.list()).toThrow(/not a directory/i);

			const missing = createContextArchive(join(cwd, "absent"));
			expect(() => missing.put(ownerInput)).toThrow();
		}));
});

describe("T7.4 - supplied provenance only (s7)", () => {
	test("put stores provenance text without reading any external file", () =>
		withArchive(async (cwd, archive) => {
			const stored = archive.put({ ...ownerInput, source: "/etc/hostname", approval: "owner-approved" });

			expect(stored.source).toBe("/etc/hostname");
			expect(stored.approval).toBe("owner-approved");
			expect(archive.read(stored.id)).toEqual(stored);
			expect(await readdir(join(cwd, ".omp", "jev", "context"))).toEqual([`${stored.id}.json`]);
			expect(Object.keys(archive).sort()).toEqual(["list", "put", "read"]);
		}));

	test("invalid provenance fields are rejected before any write", () =>
		withArchive(async (cwd, archive) => {
			expect(() => archive.put({ ...ownerInput, extra: true } as never)).toThrow(/unexpected field/i);
			expect(() => archive.put({ ...ownerInput, kind: "invented" } as never)).toThrow(/kind/i);
			expect(() => archive.put({ ...ownerInput, origin: "invented" } as never)).toThrow(/origin/i);
			expect(() => archive.put({ ...ownerInput, sessionId: "" })).toThrow(/session/i);
			expect(() => archive.put({ ...ownerInput, sequence: -1 })).toThrow(/sequence/i);
			expect(() => archive.put({ ...ownerInput, sequence: 1.5 })).toThrow(/sequence/i);
			expect(() => archive.put({ ...ownerInput, source: "" })).toThrow(/source/i);
			expect(() => archive.put({ ...ownerInput, approval: 3 } as never)).toThrow(/approval/i);

			expect(existsSync(join(cwd, ".omp"))).toBe(false);
		}));

	test("returned records are plain copies, not archive state", () =>
		withArchive(async (_cwd, archive) => {
			const stored = archive.put(ownerInput);
			stored.content = "mutated by caller";

			expect(archive.read(stored.id).content).toBe("owner text");
		}));

	test("a requirements snapshot keeps approval provenance as data only", () =>
		withArchive(async (_cwd, archive) => {
			const snapshot: Omit<ContextSource, "id" | "digest"> = {
				kind: "requirements",
				sessionId: "session-1",
				content: "requirements approved",
				origin: "judge_approved",
				approval: "approved",
			};
			const stored = archive.put(snapshot);

			expect(archive.read(stored.id).approval).toBe("approved");
			expect(archive.list()).toHaveLength(1);
		}));
});
