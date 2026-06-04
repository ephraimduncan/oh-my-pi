import { beforeAll, describe, expect, it } from "bun:test";
import { highlightSlashCommands } from "../../src/modes/slash-highlight";
import { initTheme, theme } from "../../src/modes/theme/theme";

beforeAll(async () => {
	// theme.fg("accent", …) reads the active theme's resolved colors.
	await initTheme(false);
});

const names = new Set(["skill:foo", "skill:deploy", "clear"]);

describe("highlightSlashCommands", () => {
	it("wraps recognized command and skill references without changing visible text", () => {
		const input = "use /skill:foo then /clear";
		const decorated = highlightSlashCommands(input, names);
		expect(decorated).not.toBe(input);
		expect(Bun.stripANSI(decorated)).toBe(input);
		expect(decorated).toContain(theme.fg("accent", "/skill:foo"));
		expect(decorated).toContain(theme.fg("accent", "/clear"));
	});

	it("highlights several skill references in one message", () => {
		const input = "do /skill:foo and /skill:deploy";
		const decorated = highlightSlashCommands(input, names);
		expect(decorated).toContain(theme.fg("accent", "/skill:foo"));
		expect(decorated).toContain(theme.fg("accent", "/skill:deploy"));
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("leaves unknown commands and absolute paths untouched", () => {
		expect(highlightSlashCommands("run /nope now", names)).toBe("run /nope now");
		expect(highlightSlashCommands("cat /etc/hosts", names)).toBe("cat /etc/hosts");
		// A known name embedded in a path (inner slash) is not a command token.
		expect(highlightSlashCommands("open /skill:foo/extra", names)).toBe("open /skill:foo/extra");
	});

	it("never paints references inside code spans, fenced blocks, or XML", () => {
		const input = "`/clear`\n```\n/skill:foo\n```\n<x>/clear</x>";
		expect(highlightSlashCommands(input, names)).toBe(input);
	});

	it("returns the input untouched when there are no known names", () => {
		expect(highlightSlashCommands("use /skill:foo", new Set())).toBe("use /skill:foo");
	});

	it("highlights a leading command token", () => {
		expect(highlightSlashCommands("/clear", names)).toBe(theme.fg("accent", "/clear"));
	});
});
