import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalArtifact } from "../src/artifact.js";

describe("T3 - reading a session artifact (FR-07)", () => {
	test("the artifact is read from the session's local root", async () => {
		const dir = await mkdtemp(join(tmpdir(), "jev-artifact-"));
		await mkdir(join(dir, "local"), { recursive: true });
		await writeFile(join(dir, "local", "plan.md"), "# plan\n", "utf8");
		const host = { getArtifactsDir: () => dir, getSessionId: () => "session-1" };

		expect(await readLocalArtifact(host, "plan.md")).toBe("# plan\n");
		expect(await readLocalArtifact(host, "missing.md")).toBeNull();
	});

	test("a name that would escape the artifact root is refused", async () => {
		const host = { getArtifactsDir: () => "/nowhere", getSessionId: () => "session-1" };

		expect(await readLocalArtifact(host, "../secret.md")).toBeNull();
		expect(await readLocalArtifact(host, "nested/plan.md")).toBeNull();
		expect(await readLocalArtifact(host, "")).toBeNull();
	});

	test("without a session artifact root omp's tmp fallback is used", async () => {
		const root = join(tmpdir(), "omp-local", "session_1");
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "fallback.md"), "body\n", "utf8");
		const host = { getArtifactsDir: () => null, getSessionId: () => "session/1" };

		expect(await readLocalArtifact(host, "fallback.md")).toBe("body\n");
	});
});
