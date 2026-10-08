import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, configPaths, loadJevConfig } from "../src/config.js";

const USER_FILE = "/home/owner/.omp/agent/jev.config.json";
const PROJECT_FILE = "/work/.omp/jev.config.json";

/** A config reader over an in-memory file table. */
function reader(files: Record<string, string>) {
	return (path: string): string | null => files[path] ?? null;
}

describe("T4 - configuration of the gates and the course check", () => {
	test("the fail-closed defaults apply when no file exists", () => {
		const config = loadJevConfig({ cwd: "/work", home: "/home/owner", read: reader({}) });

		expect(config).toEqual(DEFAULT_CONFIG);
		expect(config.gates.mutation).toBe(true);
		expect(config.gates.completion).toBe(true);
		expect(config.courseCheck.mode).toBe("interval");
	});

	test("the project file overrides the user file and unknown keys are ignored", () => {
		const config = loadJevConfig({
			cwd: "/work",
			home: "/home/owner",
			read: reader({
				[USER_FILE]: JSON.stringify({ gates: { mutation: true }, courseCheck: { mode: "completion", interval: 5 } }),
				[PROJECT_FILE]: JSON.stringify({
					gates: { completion: true },
					courseCheck: { interval: 2 },
					// A file written for the old shape must still load: its other keys are ignored.
					routing: { skills: [{ id: "test-driven-development" }] },
				}),
			}),
		});

		expect(config.gates).toEqual({ mutation: true, completion: true });
		expect(config.courseCheck).toEqual({ mode: "completion", interval: 2 });
		expect(config.problems).toEqual([]);
	});

	test("a gate can only be turned off explicitly", () => {
		const config = loadJevConfig({
			cwd: "/work",
			home: "/home/owner",
			read: reader({ [PROJECT_FILE]: JSON.stringify({ gates: { mutation: false, completion: false } }) }),
		});

		expect(config.gates).toEqual({ mutation: false, completion: false });
	});

	test("an invalid value keeps the fail-closed default and names the file and the key", () => {
		const config = loadJevConfig({
			cwd: "/work",
			home: "/home/owner",
			read: reader({
				[PROJECT_FILE]: JSON.stringify({
					gates: { mutation: "yes", completion: 1 },
					courseCheck: { mode: "sometimes", interval: 0 },
				}),
			}),
		});

		expect(config.gates).toEqual({ mutation: true, completion: true });
		expect(config.courseCheck).toEqual({ mode: "interval", interval: 3 });
		expect(config.problems).toHaveLength(4);
		expect(config.problems.join(" ")).toContain(PROJECT_FILE);
		expect(config.problems.join(" ")).toContain("gates.mutation");
		expect(config.problems.join(" ")).toContain("courseCheck.interval");
	});

	test("a file that is not JSON keeps every default in force", () => {
		const config = loadJevConfig({
			cwd: "/work",
			home: "/home/owner",
			read: reader({ [PROJECT_FILE]: "{oops", [USER_FILE]: "[]" }),
		});

		expect(config).toEqual({ ...DEFAULT_CONFIG, problems: config.problems });
		expect(config.problems).toHaveLength(2);
		expect(config.problems.join(" ")).toContain(USER_FILE);
		expect(config.problems.join(" ")).toContain(PROJECT_FILE);
	});

	test("the user file is read before the project file", () => {
		expect(configPaths({ cwd: "/work", home: "/home/owner" })).toEqual([USER_FILE, PROJECT_FILE]);
	});
});
