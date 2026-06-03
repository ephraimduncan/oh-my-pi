/**
 * `--worktree` / `-w` support.
 *
 * Mirrors Claude Code's `--worktree` flag: create an isolated git worktree
 * under `<repo>/.omp/worktrees/<name>` on a fresh `worktree-<name>` branch
 * (based on the current `HEAD`) and report it. The caller (`main.ts`) switches
 * the session into the returned path via `setProjectDir`, so this module never
 * changes the process directory itself.
 *
 * PR-based worktrees (`#1234`) are intentionally out of scope here — `omp gh
 * pr_checkout` already checks a pull request out into a dedicated worktree.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { generateTaskName } from "../task/name-generator";
import * as git from "../utils/git";

export interface CreatedWorktree {
	/** Slug used for the directory and the `worktree-<name>` branch. */
	name: string;
	/** Branch checked out in the new worktree. */
	branchName: string;
	/** Absolute path to the new worktree. */
	worktreePath: string;
}

/** Branch-name prefix for `--worktree`-created branches (Claude Code parity). */
const BRANCH_PREFIX = "worktree-";

/** Max disambiguation suffixes tried before giving up on a free name. */
const MAX_SUFFIX = 100;

/**
 * Convert an arbitrary label into a git-safe, lowercase slug usable as both a
 * directory name and a branch-name component. CamelCase boundaries (from
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
			// Trim leading/trailing hyphens so the result is a valid ref component.
			.replace(/^-+|-+$/g, "")
	);
}

/**
 * Detect a value that names a pull request rather than a worktree, so we can
 * point the user at the dedicated PR-checkout path instead of slugifying it
 * into a nonsensical branch name.
 */
function isPullRequestRef(value: string): boolean {
	return value.startsWith("#") || /\bgithub\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.test(value);
}

/**
 * Find a `<name>` for which both the worktree directory and the
 * `worktree-<name>` branch are unused, disambiguating with `-2`, `-3`, … when
 * the base name collides (a stale dir from an interrupted run, or a re-run with
 * the same name).
 */
async function resolveFreeName(
	baseName: string,
	worktreesDir: string,
	registeredPaths: ReadonlySet<string>,
	existingBranches: ReadonlySet<string>,
): Promise<{ name: string; branchName: string; worktreePath: string }> {
	for (let attempt = 0; attempt < MAX_SUFFIX; attempt += 1) {
		const name = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`;
		const branchName = `${BRANCH_PREFIX}${name}`;
		const worktreePath = path.join(worktreesDir, name);
		if (existingBranches.has(branchName)) continue;
		if (registeredPaths.has(path.resolve(worktreePath))) continue;
		try {
			await fs.stat(worktreePath);
			continue; // Something already on disk at this path — try the next suffix.
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		return { name, branchName, worktreePath };
	}
	throw new Error(`Could not find a free worktree name under ${worktreesDir} (tried ${MAX_SUFFIX} variants).`);
}

function reportCreatedWorktree(created: CreatedWorktree, gitignored: boolean): void {
	const { branchName, worktreePath } = created;
	process.stdout.write(`${chalk.green("Created worktree")} ${chalk.bold(branchName)}\n`);
	process.stdout.write(chalk.dim(`  ${worktreePath}\n`));
	process.stdout.write(chalk.dim(`  Remove it later with: git worktree remove ${worktreePath}\n`));
	if (!gitignored) {
		process.stdout.write(
			chalk.dim("  Tip: add .omp/worktrees/ to .gitignore to keep worktrees out of git status.\n"),
		);
	}
}

/**
 * Create the worktree described by a `--worktree` / `-w` value and report it.
 *
 * @param cwd   Directory the command was invoked from (used to locate the repo).
 * @param value `true` to auto-generate a name, otherwise the requested name.
 * @returns The created worktree; the caller is responsible for entering it.
 * @throws  When `cwd` is not inside a git repository, the value names a pull
 *          request, or git fails to create the worktree.
 */
export async function createWorktree(cwd: string, value: string | true): Promise<CreatedWorktree> {
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
	const baseName = requested || slugifyWorktreeName(generateTaskName());

	const worktreesDir = path.join(getProjectAgentDir(repoRoot), "worktrees");
	const [worktrees, branches] = await Promise.all([git.worktree.list(repoRoot), git.branch.list(repoRoot)]);
	const registeredPaths = new Set(worktrees.map(entry => path.resolve(entry.path)));
	const existingBranches = new Set(branches);

	const { name, branchName, worktreePath } = await resolveFreeName(
		baseName,
		worktreesDir,
		registeredPaths,
		existingBranches,
	);

	// `git worktree add -b worktree-<name> <path> HEAD` creates the branch from
	// the current HEAD and checks it out in the new worktree in one atomic step.
	await git.worktree.add(repoRoot, worktreePath, "HEAD", { createBranch: branchName });

	const created: CreatedWorktree = { name, branchName, worktreePath };
	const gitignored = await git.checkIgnore(repoRoot, worktreePath).catch(() => false);
	reportCreatedWorktree(created, gitignored);
	return created;
}
