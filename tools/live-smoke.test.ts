import { describe, expect, test } from "bun:test";
import { normalizeHostEvent } from "./live-smoke";

describe("host event normalization", () => {
	test("an xdev-routed extension call becomes the logical jev tool", () => {
		const raw = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "write",
			isError: true,
			result: {
				content: [{ type: "text", text: "business acceptance was not approved" }],
				details: {
					xdev: {
						tool: "jev_acceptance",
						args: { aspect: "business" },
						inner: { approved: false, revision: 3 },
					},
				},
			},
		};

		const normalized = normalizeHostEvent(raw);

		expect(normalized.toolName).toBe("jev_acceptance");
		expect(normalized.args).toEqual({ aspect: "business" });
		expect(normalized.isError).toBe(true);
		const result = normalized.result as { content: unknown; details: unknown };
		expect(result.details).toEqual({ approved: false, revision: 3 });
		expect(result.content).toEqual(raw.result.content);
	});

	test("a native call is left unchanged", () => {
		const raw = {
			type: "tool_execution_end",
			toolCallId: "call-2",
			toolName: "write",
			isError: false,
			result: { content: [], details: {} },
		};

		expect(normalizeHostEvent(raw)).toBe(raw);
	});
});
