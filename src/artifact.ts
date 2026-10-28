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

/** A complete ATX-heading section, including nested headings but excluding its next peer. */
export interface PlanSection {
	title: string;
	heading: string;
	section: string;
	start: number;
	end: number;
}

/** Read section boundaries from the artifact, never from the caller's quote. Fenced examples are data. */
export function planSections(artifact: string): PlanSection[] {
	const headings: { title: string; heading: string; start: number; body: number; level: number }[] = [];
	const fence = { marker: "", size: 0 };
	for (const line of artifact.matchAll(/[^\n]*(?:\n|$)/g)) {
		const value = line[0].replace(/\r?\n$/, "");
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(value);
		if (fence.marker !== "") {
			if (marker?.[1]?.[0] === fence.marker && marker[1].length >= fence.size && marker[2]?.trim() === "") fence.marker = "";
			continue;
		}
		if (marker?.[1] !== undefined) {
			fence.marker = marker[1][0]!;
			fence.size = marker[1].length;
			continue;
		}
		const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(value);
		if (heading?.[1] === undefined || heading[2] === undefined) continue;
		headings.push({
			title: heading[2].replace(/[ \t]+#+[ \t]*$/, ""),
			heading: value.trim(),
			start: line.index,
			body: line.index + line[0].length,
			level: heading[1].length,
		});
	}
	return headings.flatMap((heading, index) => {
		const end = headings.find((next, nextIndex) => nextIndex > index && next.level <= heading.level)?.start ?? artifact.length;
		if (artifact.slice(heading.body, end).trim().length === 0) return [];
		return [{ title: heading.title, heading: heading.heading, section: artifact.slice(heading.start, end).trimEnd(), start: heading.start, end }];
	});
}
