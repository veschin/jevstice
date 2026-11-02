import { describe, expect, test } from "bun:test";

describe("FR-57 - optional strict extension initialization", () => {
	test.each([
		{ store: undefined, run: undefined },
		{ store: "", run: "" },
		{ store: undefined, run: "inherited-run" },
	])("explicit strict entry never falls back with invalid locators: %j", async locators => {
		const code = `
			import extension from ${JSON.stringify(new URL("../autonomy/index.ts", import.meta.url).href)};
			import { fakePi, fakeCtx, fakeZod, blockReason, stopDecision } from ${JSON.stringify(new URL("./helpers.ts", import.meta.url).href)};
			const host = fakePi();
			await extension({ ...host.api, zod: fakeZod() });
			const context = fakeCtx();
			const tool = await host.emit("tool_call", { toolName: "web_search", toolCallId: "invalid-binding", input: { query: "observe only" } }, context);
			const stop = await host.emit("session_stop", {}, context);
			console.log(JSON.stringify({ toolHeld: blockReason(tool) !== undefined, stopHeld: stopDecision(stop) !== undefined }));
		`;
		const child = Bun.spawn([process.execPath, "-e", code], {
			env: { ...process.env, JEVSTICE_AUTONOMY_STORE: locators.store, JEVSTICE_AUTONOMY_RUN: locators.run },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [output, errors, exit] = await Promise.all([
			new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
		]);
		if (exit !== 0) throw new Error(`The optional strict extension host exited ${exit}: ${errors}`);
		expect(JSON.parse(output)).toEqual({ toolHeld: true, stopHeld: true });
	});
});
