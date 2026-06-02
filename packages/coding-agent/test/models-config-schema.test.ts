import { describe, expect, it } from "bun:test";
import { ModelsConfigSchema } from "../src/config/models-config-schema";

describe("ModelsConfigSchema thinking efforts", () => {
	it("accepts the max effort tier for custom Anthropic Messages models", () => {
		const result = ModelsConfigSchema.safeParse({
			providers: {
				"my-anthropic-proxy": {
					api: "anthropic-messages",
					models: [
						{
							id: "claude-opus-4-8-proxy",
							api: "anthropic-messages",
							reasoning: true,
							thinking: {
								mode: "anthropic-adaptive",
								minLevel: "low",
								maxLevel: "max",
								defaultLevel: "xhigh",
								levels: ["low", "medium", "high", "xhigh", "max"],
							},
						},
					],
				},
			},
		});
		expect(result.success).toBe(true);
	});

	it("still rejects unknown effort tiers", () => {
		const result = ModelsConfigSchema.safeParse({
			providers: {
				proxy: {
					modelOverrides: {
						"some-model": {
							thinking: { mode: "anthropic-adaptive", minLevel: "low", maxLevel: "ultra" },
						},
					},
				},
			},
		});
		expect(result.success).toBe(false);
	});
});
