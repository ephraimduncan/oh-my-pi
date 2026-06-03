import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "../src/cli/args";
import { createWorktree, slugifyWorktreeName } from "../src/cli/worktree-create";
import * as git from "../src/utils/git";

describe("parseArgs — --worktree / -w", () => {
	it("auto-generates a name when --worktree has no value (true)", () => {
		expect(parseArgs(["--worktree"]).worktree).toBe(true);
		expect(parseArgs(["-w"]).worktree).toBe(true);
	});

	it("consumes the next token as the worktree name", () => {
		expect(parseArgs(["--worktree", "feature-auth"]).worktree).toBe("feature-auth");
		expect(parseArgs(["-w", "feature-auth"]).worktree).toBe("feature-auth");
	});

	it("supports --worktree=name form", () => {
		expect(parseArgs(["--worktree=feature-auth"]).worktree).toBe("feature-auth");
	});

	it("does not consume a following flag or @file as the name", () => {
		const withFlag = parseArgs(["--worktree", "--print", "do the task"]);
		expect(withFlag.worktree).toBe(true);
		expect(withFlag.print).toBe(true);
		expect(withFlag.messages).toEqual(["do the task"]);

		const withFile = parseArgs(["-w", "@notes.md"]);
		expect(withFile.worktree).toBe(true);
		expect(withFile.fileArgs).toEqual(["notes.md"]);
	});

	it("keeps a trailing prompt after the worktree name", () => {
		const parsed = parseArgs(["-w", "myfeature", "implement the thing"]);
		expect(parsed.worktree).toBe("myfeature");
		expect(parsed.messages).toEqual(["implement the thing"]);
	});

	it("defaults worktree to undefined when the flag is absent", () => {
		expect(parseArgs(["hello"]).worktree).toBeUndefined();
	});
});

describe("slugifyWorktreeName", () => {
	it("preserves an already-clean slug", () => {
		expect(slugifyWorktreeName("feature-auth")).toBe("feature-auth");
	});

	it("splits CamelCase into hyphenated words", () => {
		expect(slugifyWorktreeName("SwiftFalcon")).toBe("swift-falcon");
	});

	it("collapses whitespace and punctuation to single hyphens and trims", () => {
		expect(slugifyWorktreeName("  Fix the Bug!! ")).toBe("fix-the-bug");
		expect(slugifyWorktreeName("a/b:c")).toBe("a-b-c");
	});

	it("returns an empty string when nothing alphanumeric survives", () => {
		expect(slugifyWorktreeName("###")).toBe("");
	});
});

describe("createWorktree (integration)", () => {
	const tempDirs: string[] = [];

	async function runGit(repo: string, args: string[]): Promise<void> {
		const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
		}
	}

	async function createGitRepo(): Promise<string> {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-create-"));
		// Resolve symlinks (/var -> /private/var on macOS) so git's reported paths
		// match the ones createWorktree derives from the same root.
		const resolved = await fs.realpath(repo);
		tempDirs.push(resolved);
		await runGit(resolved, ["init"]);
		await runGit(resolved, ["config", "user.email", "test@example.com"]);
		await runGit(resolved, ["config", "user.name", "Test User"]);
		await fs.writeFile(path.join(resolved, "file.txt"), "base\n");
		await runGit(resolved, ["add", "."]);
		await runGit(resolved, ["commit", "-m", "initial"]);
		return resolved;
	}

	beforeEach(() => {
		// Silence the creation report; the contract under test is the on-disk
		// worktree + branch, not the human-readable summary.
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	it("creates a worktree on a worktree-<name> branch under <repo>/.../worktrees", async () => {
		const repo = await createGitRepo();
		const created = await createWorktree(repo, "feature-auth");

		expect(created.name).toBe("feature-auth");
		expect(created.branchName).toBe("worktree-feature-auth");
		// Repo-local, in a `worktrees/` parent (config dir name is configurable).
		expect(created.worktreePath.startsWith(repo)).toBe(true);
		expect(path.basename(created.worktreePath)).toBe("feature-auth");
		expect(path.basename(path.dirname(created.worktreePath))).toBe("worktrees");

		const stat = await fs.stat(created.worktreePath);
		expect(stat.isDirectory()).toBe(true);

		const worktrees = await git.worktree.list(repo);
		expect(worktrees.some(entry => path.resolve(entry.path) === path.resolve(created.worktreePath))).toBe(true);

		const branches = await git.branch.list(repo);
		expect(branches).toContain("worktree-feature-auth");
	});

	it("slugifies an explicit name into a git-safe branch", async () => {
		const repo = await createGitRepo();
		const created = await createWorktree(repo, "My Feature");
		expect(created.name).toBe("my-feature");
		expect(created.branchName).toBe("worktree-my-feature");
	});

	it("auto-generates a slug name when none is given", async () => {
		const repo = await createGitRepo();
		const created = await createWorktree(repo, true);
		expect(created.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		expect(created.branchName).toBe(`worktree-${created.name}`);
		const branches = await git.branch.list(repo);
		expect(branches).toContain(created.branchName);
	});

	it("disambiguates the path and branch when a name is reused", async () => {
		const repo = await createGitRepo();
		const first = await createWorktree(repo, "dup");
		const second = await createWorktree(repo, "dup");
		expect(first.name).toBe("dup");
		expect(second.name).toBe("dup-2");
		expect(second.branchName).toBe("worktree-dup-2");
		expect(second.worktreePath).not.toBe(first.worktreePath);

		const branches = await git.branch.list(repo);
		expect(branches).toContain("worktree-dup");
		expect(branches).toContain("worktree-dup-2");
	});

	it("rejects pull-request refs with a pointer to omp gh pr_checkout", async () => {
		const repo = await createGitRepo();
		await expect(createWorktree(repo, "#1234")).rejects.toThrow(/pr_checkout/);
	});

	it("throws when not inside a git repository", async () => {
		const bare = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-not-a-repo-")));
		tempDirs.push(bare);
		await expect(createWorktree(bare, "foo")).rejects.toThrow(/git repository/);
	});
});
