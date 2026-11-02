import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, configPaths, loadJevConfig } from "../src/config.js";

const USER_FILE = "/home/owner/.omp/agent/jev.config.json";
const PROJECT_FILE = "/work/.omp/jev.config.json";

/** A config reader over an in-memory file table. */
function reader(files: Record<string, string>) {
	return (path: string): string | null => files[path] ?? null;
}

describe("T4 - configuration of the gates and the course check", () => {
	test("the shipped default holds work at both boundaries and defers the course question", () => {
		const config = loadJevConfig({ cwd: "/work", home: "/home/owner", read: reader({}) });

		expect(config).toEqual(DEFAULT_CONFIG);
		expect(config.gates.mutation).toBe(true);
		expect(config.gates.completion).toBe(true);
		expect(config.courseCheck.mode).toBe("completion");
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
		expect(config.courseCheck).toEqual({ mode: "completion", interval: 3 });
		expect(config.problems).toHaveLength(4);
		expect(config.problems.join(" ")).toContain(PROJECT_FILE);
		expect(config.problems.join(" ")).toContain("gates.mutation");
		expect(config.problems.join(" ")).toContain("courseCheck.interval");
	});

	test("a gates or courseCheck value that is not an object names the file and the key", () => {
		const config = loadJevConfig({
			cwd: "/work",
			home: "/home/owner",
			read: reader({
				[USER_FILE]: JSON.stringify({ gates: ["mutation"] }),
				[PROJECT_FILE]: JSON.stringify({ courseCheck: "interval" }),
			}),
		});

		expect(config.gates).toEqual({ mutation: true, completion: true });
		expect(config.courseCheck).toEqual({ mode: "completion", interval: 3 });
		expect(config.problems).toHaveLength(2);
		expect(config.problems.join(" ")).toContain(`${USER_FILE}: gates must be a JSON object`);
		expect(config.problems.join(" ")).toContain(`${PROJECT_FILE}: courseCheck must be a JSON object`);
	});

	test("an empty object for a section keeps the defaults and reports nothing", () => {
		const config = loadJevConfig({
			cwd: "/work",
			home: "/home/owner",
			read: reader({ [PROJECT_FILE]: JSON.stringify({ gates: {}, courseCheck: {} }) }),
		});

		expect(config).toEqual(DEFAULT_CONFIG);
		expect(config.problems).toEqual([]);
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

	test("anti-slop ships advisory and the project file can enforce it", () => {
		const shipped = loadJevConfig({ cwd: "/work", home: "/home/owner", read: reader({}) });
		expect(shipped.antiSlop).toEqual({ mode: "advisory" });

		const enforced = loadJevConfig({
			cwd: "/work",
			home: "/home/owner",
			read: reader({
				[USER_FILE]: JSON.stringify({ antiSlop: { mode: "advisory" } }),
				[PROJECT_FILE]: JSON.stringify({ antiSlop: { mode: "enforce" } }),
			}),
		});
		expect(enforced.antiSlop).toEqual({ mode: "enforce" });
		expect(enforced.problems).toEqual([]);
	});

	test("an invalid anti-slop mode keeps the default and names the file and key", () => {
		const config = loadJevConfig({
			cwd: "/work",
			home: "/home/owner",
			read: reader({
				[PROJECT_FILE]: JSON.stringify({ antiSlop: { mode: "sometimes" } }),
			}),
		});

		expect(config.antiSlop).toEqual({ mode: "advisory" });
		expect(config.problems).toHaveLength(1);
		expect(config.problems.join(" ")).toContain(`${PROJECT_FILE}: antiSlop.mode`);
	});

	test("an anti-slop section that is not an object keeps the default", () => {
		const config = loadJevConfig({
			cwd: "/work",
			home: "/home/owner",
			read: reader({ [PROJECT_FILE]: JSON.stringify({ antiSlop: "enforce" }) }),
		});

		expect(config.antiSlop).toEqual({ mode: "advisory" });
		expect(config.problems).toHaveLength(1);
		expect(config.problems.join(" ")).toContain(`${PROJECT_FILE}: antiSlop must be a JSON object`);
	});

	test("billing reads a balance and cost overrides and validates them", () => {
		const overridden = loadJevConfig({
			cwd: "/work",
			home: "/home/owner",
			read: reader({
				[PROJECT_FILE]: JSON.stringify({
					billing: { balance: 10, inputCostPerMillion: 0.05, outputCostPerMillion: 0.01 },
				}),
			}),
		});

		expect(overridden.billing).toEqual({ balance: 10, inputCostPerMillion: 0.05, outputCostPerMillion: 0.01 });
		expect(overridden.problems).toEqual([]);

		const invalid = loadJevConfig({
			cwd: "/work",
			home: "/home/owner",
			read: reader({
				[PROJECT_FILE]: JSON.stringify({ billing: { balance: -1, inputCostPerMillion: "x" } }),
			}),
		});

		expect(invalid.billing).toEqual(DEFAULT_CONFIG.billing);
		expect(invalid.problems).toHaveLength(2);
		expect(invalid.problems.join(" ")).toContain(`${PROJECT_FILE}: billing.balance`);
	});

	test("an invalid project section keeps inherited user values and reports their retained values", () => {
		const config = loadJevConfig({
			cwd: "/work",
			home: "/home/owner",
			read: reader({
				[USER_FILE]: JSON.stringify({
					gates: { mutation: false },
					courseCheck: { mode: "interval", interval: 5 },
					antiSlop: { mode: "enforce" },
					billing: { balance: 7 },
				}),
				[PROJECT_FILE]: JSON.stringify({
					gates: ["mutation"],
					courseCheck: "interval",
					antiSlop: 42,
					billing: "later",
				}),
			}),
		});

		expect(config.gates).toEqual({ mutation: false, completion: true });
		expect(config.courseCheck).toEqual({ mode: "interval", interval: 5 });
		expect(config.antiSlop).toEqual({ mode: "enforce" });
		expect(config.billing.balance).toBe(7);
		expect(config.problems).toHaveLength(4);
		const text = config.problems.join(" ");
		for (const problem of config.problems) expect(problem).toContain(PROJECT_FILE);
		expect(text).toContain("gates.mutation");
		expect(text).toContain("courseCheck.mode");
		expect(text).toContain("antiSlop.mode");
		expect(text).toContain("billing.balance");
		expect(text).toContain("false");
		expect(text).toContain("true");
		expect(text).toContain("interval");
		expect(text).toContain("5");
		expect(text).toContain("enforce");
		expect(text).toContain("7");
		expect(text).not.toContain("stays unset");
		expect(text).not.toContain("default");
	});

	test("invalid project values and unparseable files describe the retained inherited values", () => {
		const scalar = loadJevConfig({
			cwd: "/work",
			home: "/home/owner",
			read: reader({
				[USER_FILE]: JSON.stringify({ gates: { mutation: false }, billing: { balance: 7 } }),
				[PROJECT_FILE]: JSON.stringify({ gates: { mutation: "yes" }, billing: { balance: -1 } }),
			}),
		});

		expect(scalar.gates.mutation).toBe(false);
		expect(scalar.billing.balance).toBe(7);
		const scalarText = scalar.problems.join(" ");
		for (const problem of scalar.problems) expect(problem).toContain(PROJECT_FILE);
		expect(scalarText).toContain("gates.mutation");
		expect(scalarText).toContain("billing.balance");
		expect(scalarText).toContain("false");
		expect(scalarText).toContain("7");
		expect(scalarText).not.toContain("stays unset");
		expect(scalarText).not.toContain("default");

		const broken = loadJevConfig({
			cwd: "/work",
			home: "/home/owner",
			read: reader({
				[USER_FILE]: JSON.stringify({ gates: { mutation: false }, billing: { balance: 7 } }),
				[PROJECT_FILE]: "{oops",
			}),
		});

		expect(broken.gates.mutation).toBe(false);
		expect(broken.billing.balance).toBe(7);
		const brokenText = broken.problems.join(" ");
		expect(broken.problems).toHaveLength(1);
		expect(brokenText).toContain(PROJECT_FILE);
		expect(brokenText).not.toContain("fail-closed defaults");
	});
});
