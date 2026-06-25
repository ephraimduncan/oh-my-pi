import { describe, expect, it, vi } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

// `max` is Anthropic's top tier; most models do not expose it. The dispatch
// chokepoint (`mapOptionsForApi`) must clamp a `max` request down to the
// model's highest supported effort rather than forwarding an unsupported
// `max`/`xhigh` to the provider (which throws via `requireSupportedEffort`).
// These tests pin that behaviour end-to-end through `streamSimple`, the public
// path SDK callers and the deferred model-pattern startup take.

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function chatSse(): Response {
	const chunk = (delta: unknown, finish: string | null) =>
		JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] });
	return new Response(`data: ${chunk({ content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureOpenAiWireEffort(model: Model<"openai-completions">, reasoning: Effort): Promise<unknown> {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return chatSse();
	});
	for await (const event of streamSimple(model, context, { apiKey: "k", fetch: fetchMock, reasoning })) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!body) throw new Error("Expected captured chat-completions request");
	return body.reasoning_effort;
}

function captureAnthropicEffort(model: Model<"anthropic-messages">, reasoning: Effort): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	const controller = new AbortController();
	controller.abort();
	void streamSimple(model, context, {
		apiKey: "sk-ant-oat-test",
		reasoning,
		signal: controller.signal,
		onPayload: payload => resolve(payload),
	});
	return promise;
}

const OPENAI_BASE: ModelSpec<"openai-completions"> = {
	id: "test-clamp-openai",
	name: "Test Clamp OpenAI",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
};

const ANTHROPIC_BASE: ModelSpec<"anthropic-messages"> = {
	id: "test-clamp-anthropic",
	name: "Test Clamp Anthropic",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const highTopOpenAi = buildModel({
	...OPENAI_BASE,
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
}) as Model<"openai-completions">;

const xhighTopOpenAi = buildModel({
	...OPENAI_BASE,
	id: "test-clamp-openai-xhigh",
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
}) as Model<"openai-completions">;

const highTopAdaptive = buildModel({
	...ANTHROPIC_BASE,
	thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.Medium, Effort.High] },
}) as Model<"anthropic-messages">;

const maxCapableAdaptive = buildModel({
	...ANTHROPIC_BASE,
	id: "test-clamp-anthropic-max",
	thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max] },
}) as Model<"anthropic-messages">;

describe("max thinking-level clamp at the dispatch boundary", () => {
	it("clamps max to the OpenAI model's top supported tier instead of forcing xhigh", async () => {
		// Top tier is `high` — folding `max` to `xhigh` would send an unsupported
		// effort; the chokepoint must clamp to `high`.
		expect(await captureOpenAiWireEffort(highTopOpenAi, Effort.Max)).toBe("high");
		// When the model does expose `xhigh`, `max` clamps to that top tier.
		expect(await captureOpenAiWireEffort(xhighTopOpenAi, Effort.Max)).toBe("xhigh");
	});

	it("passes max through to models that support it and clamps it on those that do not", async () => {
		const maxPayload = (await captureAnthropicEffort(maxCapableAdaptive, Effort.Max)) as {
			output_config?: { effort?: string };
		};
		expect(maxPayload.output_config).toEqual({ effort: "max" });

		const clampedPayload = (await captureAnthropicEffort(highTopAdaptive, Effort.Max)) as {
			output_config?: { effort?: string };
		};
		expect(clampedPayload.output_config).toEqual({ effort: "high" });
	});
});
