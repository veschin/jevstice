/**
 * Reading a session artifact (`local://`) from disk.
 *
 * The plan review binds its approval to the artifact's exact bytes, so the file is read through the
 * host's own resolution (the session artifact root, or omp's tmp fallback) rather than trusted from
 * the caller's copy.
 */
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The session surface the artifact path is derived from. */
export interface ArtifactHost {
	getArtifactsDir?(): string | null;
	getSessionId?(): string | null;
}

/** The on-disk path of one `local://<name>` artifact, or null when the name is not a flat file. */
function localArtifactPath(host: ArtifactHost, name: string): string | null {
	if (name.length === 0 || name.includes("/") || name.includes("\\") || name.includes("..")) return null;
	const dir = host.getArtifactsDir?.();
	if (dir !== undefined && dir !== null && dir.length > 0) return join(resolve(dir, "local"), name);
	const sessionId = host.getSessionId?.() ?? "session";
	const slug = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
	const safe = slug.length > 0 && slug !== "." && slug !== ".." ? slug : "session";
	return join(tmpdir(), "omp-local", safe, name);
}

/** Read one artifact as UTF-8 text; null when it does not exist or cannot be read. */
export async function readLocalArtifact(host: ArtifactHost, name: string): Promise<string | null> {
	const path = localArtifactPath(host, name);
	if (path === null) return null;
	try {
		return await Bun.file(path).text();
	} catch {
		return null;
	}
}
