import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, configPaths, loadJevConfig } from "../src/config.js";

const USER_FILE = "/home/owner/.omp/agent/jev.config.json";
const PROJECT_FILE = "/work/.omp/jev.config.json";

/** A config reader over an in-memory file table. */
function reader(files: Record<string, string>) {
	return (path: string): string | null => files[path] ?? null;
}

describe("T4 - diagnostic configuration", () => {
	test("diagnostics are advisory and expose no execution gates or schedule", () => {
		const config = loadJevConfig({ cwd: "/work", home: "/home/owner", read: reader({}) });
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(config.antiSlop.mode).toBe("advisory");
		expect(Object.hasOwn(config, "gates")).toBe(false);
		expect(Object.hasOwn(config, "courseCheck")).toBe(false);
	});

	test("obsolete gate and schedule keys cannot restore blocking", () => {
		const config = loadJevConfig({
			cwd: "/work", home: "/home/owner",
			read: reader({
				[USER_FILE]: JSON.stringify({ gates: { mutation: true, completion: true } }),
				[PROJECT_FILE]: JSON.stringify({ gates: ["invalid"], courseCheck: { mode: "interval", interval: 0 }, routing: {} }),
			}),
		});
		expect(config).toEqual(DEFAULT_CONFIG);
	});

	test("the project file overrides inherited diagnostic preferences", () => {
		const config = loadJevConfig({
			cwd: "/work", home: "/home/owner",
			read: reader({
				[USER_FILE]: JSON.stringify({ antiSlop: { mode: "off" } }),
				[PROJECT_FILE]: JSON.stringify({ antiSlop: { mode: "advisory" } }),
			}),
		});
		expect(config.antiSlop.mode).toBe("advisory");
		expect(config.problems).toEqual([]);
	});

	test("empty diagnostic sections retain the defaults", () => {
		const config = loadJevConfig({
			cwd: "/work", home: "/home/owner",
			read: reader({ [PROJECT_FILE]: JSON.stringify({ antiSlop: {}, billing: {} }) }),
		});
		expect(config).toEqual(DEFAULT_CONFIG);
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

	test("the removed enforce mode is diagnosed rather than restored", () => {
		const config = loadJevConfig({
			cwd: "/work", home: "/home/owner",
			read: reader({ [PROJECT_FILE]: JSON.stringify({ antiSlop: { mode: "enforce" } }) }),
		});
		expect(config.antiSlop.mode).toBe("advisory");
		expect(config.problems).toHaveLength(1);
		expect(config.problems[0]).toContain(`${PROJECT_FILE}: antiSlop.mode`);
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
		const problem = config.problems[0] ?? "";
		expect(problem).toContain(PROJECT_FILE);
		expect(problem).toContain("antiSlop");
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
					antiSlop: { mode: "off" },
					billing: { balance: 7 },
				}),
				[PROJECT_FILE]: JSON.stringify({
					antiSlop: 42,
					billing: "later",
				}),
			}),
		});

		expect(config.antiSlop).toEqual({ mode: "off" });
		expect(config.billing.balance).toBe(7);
		expect(config.problems).toHaveLength(2);
		const text = config.problems.join(" ");
		for (const problem of config.problems) expect(problem).toContain(PROJECT_FILE);
		expect(text).toContain("antiSlop.mode");
		expect(text).toContain("billing.balance");
		expect(text).toContain("off");
		expect(text).toContain("7");
	});

	test("invalid project values and unparseable files describe the retained inherited values", () => {
		const scalar = loadJevConfig({
			cwd: "/work",
			home: "/home/owner",
			read: reader({
				[USER_FILE]: JSON.stringify({ antiSlop: { mode: "off" }, billing: { balance: 7 } }),
				[PROJECT_FILE]: JSON.stringify({ antiSlop: { mode: "invalid" }, billing: { balance: -1 } }),
			}),
		});

		expect(scalar.antiSlop.mode).toBe("off");
		expect(scalar.billing.balance).toBe(7);
		const scalarText = scalar.problems.join(" ");
		for (const problem of scalar.problems) expect(problem).toContain(PROJECT_FILE);
		expect(scalarText).toContain("antiSlop.mode");
		expect(scalarText).toContain("billing.balance");
		expect(scalarText).toContain("off");
		expect(scalarText).toContain("7");

		const broken = loadJevConfig({
			cwd: "/work",
			home: "/home/owner",
			read: reader({
				[USER_FILE]: JSON.stringify({ antiSlop: { mode: "off" }, billing: { balance: 7 } }),
				[PROJECT_FILE]: "{oops",
			}),
		});

		expect(broken.antiSlop.mode).toBe("off");
		expect(broken.billing.balance).toBe(7);
		const brokenText = broken.problems.join(" ");
		expect(broken.problems).toHaveLength(1);
		expect(brokenText).toContain(PROJECT_FILE);
	});
});
