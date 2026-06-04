import { maskNonProse } from "./markdown-prose";
import { theme } from "./theme/theme";

/**
 * A `/token` reference at a whitespace/edge boundary: "/" then a command-name
 * body containing no inner "/" (so absolute paths like `/bin/sh` never match)
 * and not immediately followed by "/". The captured group is the bare command
 * name (e.g. `model`, `skill:computer-use`) checked against the known set.
 * Non-global probe is the cheap `includes("/")` test in the highlighter.
 */
const SLASH_TOKEN = /(?<!\S)\/([A-Za-z0-9][A-Za-z0-9:._-]*)(?!\/)/g;

/**
 * Foreground-highlight every recognized slash command / skill reference in
 * `text` for editor display: a `/command` or `/skill:name` token whose name is
 * present in `names`, appearing in prose — never inside an inline code span,
 * fenced block, or XML/HTML section. Adds only zero-width SGR escapes, so the
 * visible width is unchanged, and returns the input untouched when there is
 * nothing to mark. Designed to chain with the magic-keyword highlighters: it
 * injects no backticks or angle brackets, so masking in either pass is unaffected.
 */
export function highlightSlashCommands(text: string, names: ReadonlySet<string>): string {
	if (names.size === 0 || !text.includes("/")) return text;
	// Match against a code/markup-masked copy so references inside code spans,
	// fenced blocks, or XML sections never paint; indices still address `text`.
	const masked = maskNonProse(text);
	let out = "";
	let last = 0;
	for (const m of masked.matchAll(SLASH_TOKEN)) {
		const name = m[1];
		if (!name || !names.has(name)) continue;
		const start = m.index ?? 0;
		const end = start + m[0].length;
		out += text.slice(last, start) + theme.fg("accent", text.slice(start, end));
		last = end;
	}
	return last === 0 ? text : out + text.slice(last);
}
