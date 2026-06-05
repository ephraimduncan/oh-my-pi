/**
 * `--worktree` / `-w` support.
 *
 * Runs the main session inside an isolated workspace, reusing the same
 * user-chosen isolation primitive that subagent tasks use: the
 * `task.isolation.mode` setting drives the native PAL (`isoResolve` /
 * `isoStart`), which materialises a writable view of the repository — a
 * CoW clone, a snapshot, or a recursive copy — under `~/.omp/wt/<name>/merged`.
 * Mount-only backends (overlayfs/projfs) are excluded here: the workspace must
 * persist as a real directory after the session exits (see below), which a live
 * mount does not provide.
 * The caller (`main.ts`) switches the session into the returned path via
 * `setProjectDir`, so this module never changes the process directory itself.
 *
 * The workspace is persistent: it is left in place when the session ends so
 * the user can inspect, diff, and merge it manually (`rm -rf <path>` or
 * `omp wt`). Unlike subagent isolation there is no auto merge-back or cleanup.
 *
 * PR-based worktrees (`#1234`) are intentionally out of scope — `omp gh
 * pr_checkout` already checks a pull request out into a dedicated worktree.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { generateTaskName } from "../task/name-generator";
import {
	ensureIsolation,
	PERSISTENT_WORKTREE_MARKER,
	parseIsolationMode,
	resolveIsolationPaths,
	type TaskIsolationMode,
} from "../task/worktree";
import * as git from "../utils/git";

const { IsoBackendKind } = natives;
type IsoBackendKind = natives.IsoBackendKind;

export interface CreatedWorktree {
	/** Slug used as the isolation id and `~/.omp/wt/<name>` segment. */
	name: string;
	/** Absolute path to the isolated workspace the session runs in. */
	workspacePath: string;
	/** Backend the PAL actually materialised the workspace with. */
	backend: IsoBackendKind;
	/** True when the PAL downgraded from the requested backend. */
	fellBack: boolean;
	/** Reason associated with `fellBack`, when the PAL reported one. */
	fallbackReason: string | null;
}

/** Human-readable label per backend (mirrors the `task.isolation.mode` names). */
const BACKEND_LABELS: Record<IsoBackendKind, string> = {
	[IsoBackendKind.Apfs]: "apfs",
	[IsoBackendKind.Btrfs]: "btrfs",
	[IsoBackendKind.Zfs]: "zfs",
	[IsoBackendKind.LinuxReflink]: "reflink",
	[IsoBackendKind.Overlayfs]: "overlayfs",
	[IsoBackendKind.Projfs]: "projfs",
	[IsoBackendKind.WindowsBlockClone]: "block-clone",
	[IsoBackendKind.Rcopy]: "rcopy",
};

/**
 * Backends whose `merged` view is a live mount, not a real on-disk directory.
 * A persistent `--worktree` workspace must survive process exit as an inspectable
 * directory the user can diff and `rm -rf`; a mount-only view does not (its
 * contents vanish on unmount, with changes stranded in a sibling upper/work dir),
 * so `createWorktree` rejects them when explicit and excludes them from auto.
 */
const MOUNT_ONLY_BACKENDS: ReadonlySet<IsoBackendKind> = new Set([IsoBackendKind.Overlayfs, IsoBackendKind.Projfs]);

/**
 * Convert an arbitrary label into a git-safe, lowercase slug usable as the
 * isolation id and directory segment. CamelCase boundaries (from
 * {@link generateTaskName}) split into words; every other run of non-alphanumeric
 * characters collapses to a single hyphen. Returns `""` when nothing survives.
 */
export function slugifyWorktreeName(input: string): string {
	return (
		input
			.trim()
			// Split camelCase / PascalCase boundaries: "SwiftFalcon" -> "Swift Falcon".
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.toLowerCase()
			// Any run of non-alphanumeric characters -> single hyphen.
			.replace(/[^a-z0-9]+/g, "-")
			// Trim leading/trailing hyphens so the result is a clean segment.
			.replace(/^-+|-+$/g, "")
	);
}

/**
 * Detect a value that names a pull request rather than a worktree, so we can
 * point the user at the dedicated PR-checkout path instead of slugifying it
 * into a nonsensical name.
 */
function isPullRequestRef(value: string): boolean {
	return value.startsWith("#") || /\bgithub\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.test(value);
}

function reportCreatedWorktree(created: CreatedWorktree): void {
	const { name, workspacePath, backend, fellBack, fallbackReason } = created;
	process.stderr.write(
		`${chalk.green("Isolated workspace")} ${chalk.bold(name)} ${chalk.dim(`(${BACKEND_LABELS[backend]})`)}\n`,
	);
	process.stderr.write(chalk.dim(`  ${workspacePath}\n`));
	if (fellBack) {
		const reason = fallbackReason ? `: ${fallbackReason}` : "";
		process.stderr.write(
			chalk.yellow(`  Requested backend unavailable — fell back to ${BACKEND_LABELS[backend]}${reason}\n`),
		);
	}
	process.stderr.write(chalk.dim(`  Remove it later with: rm -rf ${workspacePath}\n`));
}

/**
 * Materialise the isolated workspace described by a `--worktree` / `-w` value
 * and report it.
 *
 * @param cwd           Directory the command was invoked from (used to locate the repo).
 * @param value         `true` to auto-generate a name, otherwise the requested name.
 * @param isolationMode The user's `task.isolation.mode` — the chosen isolation primitive.
 * @returns The created workspace; the caller is responsible for entering it.
 * @throws  When `cwd` is not inside a git repository, the value names a pull
 *          request, or no isolation backend can be started.
 */
export async function createWorktree(
	cwd: string,
	value: string | true,
	isolationMode: TaskIsolationMode,
): Promise<CreatedWorktree> {
	const repoRoot = await git.repo.root(cwd);
	if (!repoRoot) {
		throw new Error(
			"--worktree requires a git repository. Run omp from inside a repo, or initialize one with `git init`.",
		);
	}

	if (value !== true && isPullRequestRef(value.trim())) {
		throw new Error(
			`--worktree does not check out pull requests. Use \`omp gh pr_checkout ${value.trim()}\` for a PR worktree.`,
		);
	}

	const requested = value === true ? "" : slugifyWorktreeName(value);
	// An empty/garbage name (e.g. `-w "###"`) falls back to an auto-generated one.
	const name = requested || slugifyWorktreeName(generateTaskName());
	// Refuse to clobber an existing workspace: ensureIsolation rm -rf's the base
	// dir before re-creating it, which would silently destroy unmerged edits from
	// a previous `--worktree <name>` session. Require the user to inspect/merge/
	// remove it or pick a different name.
	const { baseDir } = await resolveIsolationPaths(cwd, name);
	const baseDirExists = await fs.stat(baseDir).then(
		() => true,
		() => false,
	);
	if (baseDirExists) {
		throw new Error(
			`A worktree named "${name}" already exists at ${baseDir}. Inspect or merge it, remove it (\`rm -rf ${baseDir}\` or \`omp wt clear --all\`), or choose a different --worktree name.`,
		);
	}

	const requestedBackend = parseIsolationMode(isolationMode);
	if (requestedBackend !== undefined && MOUNT_ONLY_BACKENDS.has(requestedBackend)) {
		throw new Error(
			`--worktree cannot use the "${isolationMode}" isolation backend: it is mount-only, but a persistent worktree must stay a real directory after the session ends (so you can inspect, diff, and \`rm -rf\` it). Set task.isolation.mode to a directory-materializing backend — rcopy, reflink, apfs, btrfs, zfs, or block-clone.`,
		);
	}
	// Persistent worktrees need a directory-materializing backend; exclude
	// mount-only views so auto-resolution downgrades to rcopy instead of leaving
	// an unusable live mount behind.
	const handle = await ensureIsolation(cwd, name, requestedBackend, { excludeBackends: MOUNT_ONLY_BACKENDS });

	// Mark this as a persistent worktree so `omp wt clear` treats it as a live
	// workspace (not a task-isolation leftover) and leaves it unless `--all` is
	// passed. Best-effort: a missing marker only forfeits that protection.
	try {
		await fs.writeFile(
			path.join(baseDir, PERSISTENT_WORKTREE_MARKER),
			`${JSON.stringify({ name, createdAt: new Date().toISOString() })}\n`,
		);
	} catch (err) {
		logger.warn("failed to write persistent worktree marker", {
			baseDir,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	const created: CreatedWorktree = {
		name,
		workspacePath: handle.mergedDir,
		backend: handle.backend,
		fellBack: handle.fellBack,
		fallbackReason: handle.fallbackReason,
	};
	reportCreatedWorktree(created);
	return created;
}
