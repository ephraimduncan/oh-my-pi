import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { parseArgs } from "../src/cli/args";
import { createWorktree, slugifyWorktreeName } from "../src/cli/worktree-create";
import { parseIsolationMode } from "../src/task/worktree";

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
		// Resolve symlinks (/var -> /private/var on macOS) so git's reported repo
		// root matches the one the PAL derives from the same directory.
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
		// Silence the creation report; the contract under test is the returned
		// handle and the backend the PAL was asked for, not the printed summary.
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
	});

	afterEach(async () => {
		// isoStart is always mocked, so nothing is written under ~/.omp/wt.
		vi.restoreAllMocks();
		await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	it("materialises an isolated workspace via the PAL under <wt>/<name>/merged", async () => {
		const repo = await createGitRepo();
		const isoStart = vi.spyOn(natives, "isoStart").mockResolvedValue(undefined);
		vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Rcopy,
			candidates: [natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});

		const created = await createWorktree(repo, "feature-auth", "rcopy");

		expect(created.name).toBe("feature-auth");
		expect(created.backend).toBe(natives.IsoBackendKind.Rcopy);
		expect(created.fellBack).toBe(false);
		// The workspace is the PAL's merged view, keyed by the slug.
		expect(path.basename(created.workspacePath)).toBe("merged");
		expect(path.basename(path.dirname(created.workspacePath))).toMatch(/^feature-auth-[0-9a-f]+$/);
		// isoStart got the resolved backend, the repo as the lower dir, and the
		// merged path as the target.
		expect(isoStart).toHaveBeenCalledTimes(1);
		expect(isoStart).toHaveBeenCalledWith(natives.IsoBackendKind.Rcopy, expect.any(String), created.workspacePath);
	});

	it("passes the user-chosen isolation mode to the PAL as the preferred backend", async () => {
		const repo = await createGitRepo();
		const isoResolve = vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Apfs,
			candidates: [natives.IsoBackendKind.Apfs],
			fellBack: false,
			reason: undefined,
		});
		vi.spyOn(natives, "isoStart").mockResolvedValue(undefined);

		await createWorktree(repo, "x", "apfs");

		expect(isoResolve).toHaveBeenCalledWith(parseIsolationMode("apfs"));
		expect(isoResolve).toHaveBeenCalledWith(natives.IsoBackendKind.Apfs);
	});

	it("treats task.isolation.mode=none as an auto-resolve hint, not 'skip isolation'", async () => {
		const repo = await createGitRepo();
		const isoResolve = vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Rcopy,
			candidates: [natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});
		vi.spyOn(natives, "isoStart").mockResolvedValue(undefined);

		await createWorktree(repo, "x", "none");

		// `none` -> parseIsolationMode -> undefined -> isoResolve(null): `-w` is an
		// explicit opt-in, so it isolates even when subagent isolation is disabled.
		expect(isoResolve).toHaveBeenCalledWith(null);
	});

	it("auto-generates a slug name when no name is given", async () => {
		const repo = await createGitRepo();
		vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Rcopy,
			candidates: [natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});
		vi.spyOn(natives, "isoStart").mockResolvedValue(undefined);

		const created = await createWorktree(repo, true, "auto");

		expect(created.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
	});

	it("surfaces the PAL fallback when the requested backend is unavailable", async () => {
		const repo = await createGitRepo();
		const unavailable = new Error("ISO_UNAVAILABLE: btrfs source is not a subvolume");
		vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Btrfs,
			candidates: [natives.IsoBackendKind.Btrfs, natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});
		vi.spyOn(natives, "isoStart").mockRejectedValueOnce(unavailable).mockResolvedValueOnce(undefined);
		vi.spyOn(natives, "isoIsUnavailableError").mockImplementation(message => message.startsWith("ISO_UNAVAILABLE:"));

		const created = await createWorktree(repo, "fallback", "btrfs");

		expect(created.backend).toBe(natives.IsoBackendKind.Rcopy);
		expect(created.fellBack).toBe(true);
		expect(created.fallbackReason).toBe(unavailable.message);
	});

	it("rejects an explicit mount-only backend (overlayfs) for a persistent worktree", async () => {
		const repo = await createGitRepo();
		const isoStart = vi.spyOn(natives, "isoStart").mockResolvedValue(undefined);
		// overlayfs is mount-only; a persistent worktree needs a real directory.
		await expect(createWorktree(repo, "x", "overlayfs")).rejects.toThrow(/mount-only/i);
		// Rejected before any workspace was materialised.
		expect(isoStart).not.toHaveBeenCalled();
	});

	it("excludes mount-only backends from auto-resolution and floors to rcopy", async () => {
		const repo = await createGitRepo();
		// Auto resolution offers only overlayfs (mount-only); the exclude filter
		// must drop it and floor to rcopy so the workspace stays a real directory.
		vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Overlayfs,
			candidates: [natives.IsoBackendKind.Overlayfs],
			fellBack: false,
			reason: undefined,
		});
		const isoStart = vi.spyOn(natives, "isoStart").mockResolvedValue(undefined);

		const created = await createWorktree(repo, "auto-wt", "auto");

		expect(created.backend).toBe(natives.IsoBackendKind.Rcopy);
		// overlayfs was never started; rcopy was substituted by the exclude filter.
		expect(isoStart).toHaveBeenCalledTimes(1);
		expect(isoStart).toHaveBeenCalledWith(natives.IsoBackendKind.Rcopy, expect.any(String), created.workspacePath);
	});

	it("writes the workspace banner to stderr, never stdout (keeps --mode json output clean)", async () => {
		const repo = await createGitRepo();
		vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Rcopy,
			candidates: [natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});
		vi.spyOn(natives, "isoStart").mockResolvedValue(undefined);
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);

		await createWorktree(repo, "banner", "rcopy");

		expect(stdoutWrite).not.toHaveBeenCalled();
	});

	it("rejects pull-request refs with a pointer to omp gh pr_checkout", async () => {
		const repo = await createGitRepo();
		await expect(createWorktree(repo, "#1234", "auto")).rejects.toThrow(/pr_checkout/);
	});

	it("throws when not inside a git repository", async () => {
		const bare = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-not-a-repo-")));
		tempDirs.push(bare);
		await expect(createWorktree(bare, "foo", "auto")).rejects.toThrow(/git repository/);
	});

	it("does not materialise a workspace when a worktree-independent validation rejects the invocation", async () => {
		// Regression (PR #1773 review): the RPC `@file` check must run before the
		// worktree side-effect, so an invalid invocation leaves no isolated workspace.
		const repo = await createGitRepo();
		const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-home-")));
		tempDirs.push(home);
		const cliPath = path.join(import.meta.dir, "../src/cli.ts");
		const proc = Bun.spawn([process.execPath, cliPath, "--worktree", "wtjunk", "--mode", "rpc", "@notes.md"], {
			cwd: repo,
			env: { ...process.env, HOME: home, PI_NO_TITLE: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		const stderr = await new Response(proc.stderr).text();

		expect(exitCode).toBe(1);
		expect(stderr).toContain("@file arguments are not supported");
		// No isolated workspace dir was created under the (temp) home.
		await expect(fs.stat(path.join(home, ".omp", "wt"))).rejects.toThrow();
	}, 20_000);
});
