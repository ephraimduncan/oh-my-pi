import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

describe("status-line thinking indicators", () => {
	beforeAll(() => {
		initTheme();
	});

	it("provides a non-empty status-line symbol for every selectable effort", () => {
		// The model status-line segment only appends the indicator when
		// `theme.thinking[level]` is truthy (segments.ts), so a selectable effort
		// without a symbol silently drops the indicator.
		const missing = THINKING_EFFORTS.filter(level => !theme.thinking[level as keyof typeof theme.thinking]);
		expect(missing).toEqual([]);
	});

	it("gives the max tier the top-tier border color, not the disabled fallback", () => {
		const off = theme.getThinkingBorderColor(ThinkingLevel.Off)("x");
		const max = theme.getThinkingBorderColor(Effort.Max)("x");
		const xhigh = theme.getThinkingBorderColor(Effort.XHigh)("x");
		expect(max).not.toBe(off);
		expect(max).toBe(xhigh);
	});
});
