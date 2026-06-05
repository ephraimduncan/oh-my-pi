import * as fs from "node:fs/promises";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { AutocompleteProvider, SlashCommand } from "@oh-my-pi/pi-tui";
import { $env, sanitizeText } from "@oh-my-pi/pi-utils";
import { getRoleInfo } from "../../config/model-registry";
import { isSettingsInitialized, settings } from "../../config/settings";
import { buildSkillPromptMessage } from "../../extensibility/skills";
import { renderSegmentTrack } from "../../modes/components/segment-track";
import { TinyTitleDownloadProgressComponent } from "../../modes/components/tiny-title-download-progress";
import { expandEmoticons } from "../../modes/emoji-autocomplete";
import { maskNonProse } from "../../modes/markdown-prose";
import { createPromptActionAutocompleteProvider } from "../../modes/prompt-action-autocomplete";
import type { InteractiveModeContext } from "../../modes/types";
import type { AgentSessionEvent } from "../../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "../../session/messages";
import { executeBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { isTinyTitleLocalModelKey } from "../../tiny/models";
import { isLowSignalTitleInput } from "../../tiny/text";
import { tinyTitleClient } from "../../tiny/title-client";
import type { TinyTitleProgressEvent } from "../../tiny/title-protocol";
import { copyToClipboard, readImageFromClipboard, readTextFromClipboard } from "../../utils/clipboard";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { ensureSupportedImageInput } from "../../utils/image-loading";
import { resizeImage } from "../../utils/image-resize";
import { generateSessionTitle, setSessionTerminalTitle } from "../../utils/title-generator";

interface SkillReference {
	/** Full command name including the `skill:` prefix (e.g. `skill:computer-use`). */
	commandName: string;
	/** Bare skill name without the `skill:` prefix. */
	name: string;
	/** Absolute path to the skill file. */
	path: string;
	/** Offset of the leading "/" in the source text. */
	start: number;
	/** Offset just past the reference token in the source text. */
	end: number;
}

interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

const TINY_TITLE_PROGRESS_DONE_TTL_MS = 3_000;
// A cached model fires its file-load events in a short burst and then goes silent
// while onnxruntime builds the session; a genuine download keeps streaming progress
// events for seconds. Only reveal the bar once a still-incomplete event arrives after
// this grace window, so an already-downloaded model never flashes the bar.
const TINY_TITLE_PROGRESS_REVEAL_DELAY_MS = 1_000;

export class InputController {
	constructor(private ctx: InteractiveModeContext) {}

	#showTinyTitleDownloadProgress(modelKey: string): void {
		if (!isTinyTitleLocalModelKey(modelKey) || this.ctx.isBackgrounded) return;
		const component = new TinyTitleDownloadProgressComponent(modelKey);
		let added = false;
		let disposed = false;
		let removeTimer: NodeJS.Timeout | undefined;
		const remove = (): void => {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			if (removeTimer) {
				clearTimeout(removeTimer);
				removeTimer = undefined;
			}
			if (added) {
				this.ctx.chatContainer.removeChild(component);
				this.ctx.ui.requestRender();
			}
		};
		const scheduleRemove = (): void => {
			if (removeTimer) clearTimeout(removeTimer);
			removeTimer = setTimeout(remove, TINY_TITLE_PROGRESS_DONE_TTL_MS);
			removeTimer.unref?.();
		};
		let revealAt = 0;
		const update = (event: TinyTitleProgressEvent): void => {
			if (disposed || event.modelKey !== modelKey) return;
			component.update(event);
			if (revealAt === 0) revealAt = performance.now() + TINY_TITLE_PROGRESS_REVEAL_DELAY_MS;
			const complete = component.isComplete();
			// Reveal only for a download still in flight past the grace window. Cache hits
			// either complete or fall silent (onnx init emits no events) before this fires.
			if (!added && !complete && performance.now() >= revealAt) {
				this.ctx.chatContainer.addChild(component);
				added = true;
			}
			if (added) this.ctx.ui.requestRender();
			if (complete) {
				if (added) scheduleRemove();
				else remove();
			}
		};
		const unsubscribe = tinyTitleClient.onProgress(update);
	}

	setupKeyHandlers(): void {
		this.ctx.editor.setActionKeys("app.interrupt", this.ctx.keybindings.getKeys("app.interrupt"));
		this.ctx.editor.onEscape = () => {
			if (this.ctx.loopModeEnabled) {
				this.ctx.pauseLoop();
				if (this.ctx.session.isStreaming) {
					void this.ctx.session.abort();
				} else {
					this.ctx.cancelPendingSubmission();
				}
				return;
			}
			if (this.ctx.hasActiveBtw() && this.ctx.handleBtwEscape()) {
				return;
			}
			if (this.ctx.hasActiveOmfg() && this.ctx.handleOmfgEscape()) {
				return;
			}
			if (this.ctx.loadingAnimation) {
				if (this.ctx.cancelPendingSubmission()) {
					return;
				}
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.ctx.session.isBashRunning) {
				this.ctx.session.abortBash();
			} else if (this.ctx.isBashMode) {
				this.ctx.editor.setText("");
				this.ctx.isBashMode = false;
				this.ctx.updateEditorBorderColor();
			} else if (this.ctx.session.isEvalRunning) {
				this.ctx.session.abortEval();
			} else if (this.ctx.isPythonMode) {
				this.ctx.editor.setText("");
				this.ctx.isPythonMode = false;
				this.ctx.updateEditorBorderColor();
			} else if (this.ctx.session.isStreaming) {
				void this.ctx.session.abort();
			} else if (!this.ctx.editor.getText().trim()) {
				// Double-interrupt with empty editor triggers /tree, /branch, or nothing based on setting
				const action = settings.get("doubleEscapeAction");
				if (action !== "none") {
					const now = Date.now();
					if (now - this.ctx.lastEscapeTime < 500) {
						if (action === "tree") {
							this.ctx.showTreeSelector();
						} else {
							this.ctx.showUserMessageSelector();
						}
						this.ctx.lastEscapeTime = 0;
					} else {
						this.ctx.lastEscapeTime = now;
					}
				}
			}
		};

		this.ctx.editor.setActionKeys("app.clear", this.ctx.keybindings.getKeys("app.clear"));
		this.ctx.editor.onClear = () => this.handleCtrlC();
		this.ctx.editor.setActionKeys("app.exit", this.ctx.keybindings.getKeys("app.exit"));
		this.ctx.editor.onExit = () => this.handleCtrlD();
		this.ctx.editor.setActionKeys("app.suspend", this.ctx.keybindings.getKeys("app.suspend"));
		this.ctx.editor.onSuspend = () => this.handleCtrlZ();
		this.ctx.editor.setActionKeys("app.thinking.cycle", this.ctx.keybindings.getKeys("app.thinking.cycle"));
		this.ctx.editor.onCycleThinkingLevel = () => this.cycleThinkingLevel();
		this.ctx.editor.setActionKeys("app.model.cycleForward", this.ctx.keybindings.getKeys("app.model.cycleForward"));
		this.ctx.editor.onCycleModelForward = () => this.cycleRoleModel("forward");
		this.ctx.editor.setActionKeys("app.model.cycleBackward", this.ctx.keybindings.getKeys("app.model.cycleBackward"));
		this.ctx.editor.onCycleModelBackward = () => this.cycleRoleModel("backward");
		this.ctx.editor.setActionKeys(
			"app.model.selectTemporary",
			this.ctx.keybindings.getKeys("app.model.selectTemporary"),
		);
		this.ctx.editor.onSelectModelTemporary = () => this.ctx.showModelSelector({ temporaryOnly: true });

		// Global debug handler on TUI (works regardless of focus)
		this.ctx.ui.onDebug = () => this.ctx.showDebugSelector();
		this.ctx.editor.setActionKeys("app.model.select", this.ctx.keybindings.getKeys("app.model.select"));
		this.ctx.editor.onSelectModel = () => this.ctx.showModelSelector();
		this.ctx.editor.setActionKeys("app.history.search", this.ctx.keybindings.getKeys("app.history.search"));
		this.ctx.editor.onHistorySearch = () => this.ctx.showHistorySearch();
		this.ctx.editor.setActionKeys("app.thinking.toggle", this.ctx.keybindings.getKeys("app.thinking.toggle"));
		this.ctx.editor.onToggleThinking = () => this.ctx.toggleThinkingBlockVisibility();
		this.ctx.editor.setActionKeys("app.editor.external", this.ctx.keybindings.getKeys("app.editor.external"));
		this.ctx.editor.onExternalEditor = () => void this.openExternalEditor();
		this.ctx.editor.setActionKeys(
			"app.clipboard.pasteImage",
			this.ctx.keybindings.getKeys("app.clipboard.pasteImage"),
		);
		this.ctx.editor.onPasteImage = () => this.handleImagePaste();
		this.ctx.editor.setActionKeys(
			"app.clipboard.pasteTextRaw",
			this.ctx.keybindings.getKeys("app.clipboard.pasteTextRaw"),
		);
		this.ctx.editor.onPasteTextRaw = () => void this.handleClipboardTextRawPaste();
		this.ctx.editor.setActionKeys(
			"app.clipboard.copyPrompt",
			this.ctx.keybindings.getKeys("app.clipboard.copyPrompt"),
		);
		this.ctx.editor.onCopyPrompt = () => this.handleCopyPrompt();
		this.ctx.editor.setActionKeys("app.tools.expand", this.ctx.keybindings.getKeys("app.tools.expand"));
		this.ctx.editor.onExpandTools = () => this.toggleToolOutputExpansion();
		this.ctx.editor.setActionKeys("app.message.dequeue", this.ctx.keybindings.getKeys("app.message.dequeue"));
		this.ctx.editor.onDequeue = () => this.handleDequeue();

		this.ctx.editor.clearCustomKeyHandlers();
		// Wire up extension shortcuts
		this.registerExtensionShortcuts();

		const planModeKeys = this.ctx.keybindings.getKeys("app.plan.toggle");
		for (const key of planModeKeys) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.handlePlanModeCommand());
		}

		for (const key of this.ctx.keybindings.getKeys("app.session.new")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.handleClearCommand());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.tree")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showTreeSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.fork")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showUserMessageSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.resume")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showSessionSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.message.followUp")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.handleFollowUp());
		}
		for (const key of this.ctx.keybindings.getKeys("app.stt.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.handleSTTToggle());
		}
		for (const key of this.ctx.keybindings.getKeys("app.clipboard.copyLine")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.handleCopyCurrentLine());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.observe")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showSessionObserver());
		}

		this.ctx.editor.onChange = (text: string) => {
			const wasBashMode = this.ctx.isBashMode;
			const wasPythonMode = this.ctx.isPythonMode;
			const trimmed = text.trimStart();
			this.ctx.isBashMode = text.trimStart().startsWith("!");
			this.ctx.isPythonMode = trimmed.startsWith("$") && !trimmed.startsWith("${");
			if (wasBashMode !== this.ctx.isBashMode || wasPythonMode !== this.ctx.isPythonMode) {
				this.ctx.updateEditorBorderColor();
			}
		};
	}

	setupEditorSubmitHandler(): void {
		this.ctx.editor.onSubmit = async (text: string) => {
			text = text.trim();
			if ((!isSettingsInitialized() || settings.get("emojiAutocomplete")) && text) text = expandEmoticons(text);

			// Empty submit while streaming with queued messages: flush queues immediately
			if (!text && this.ctx.session.isStreaming && this.ctx.session.queuedMessageCount > 0) {
				// Abort current stream and let queued messages be processed
				await this.ctx.session.abort();
				return;
			}

			if (!text) return;

			// Continue shortcuts: "." or "c" sends empty message (agent continues, no visible message)
			if (text === "." || text === "c") {
				if (this.ctx.onInputCallback) {
					this.ctx.editor.setText("");
					this.ctx.pendingImages = [];
					this.ctx.onInputCallback({ text: "", cancelled: false, started: true });
				}
				return;
			}

			const runner = this.ctx.session.extensionRunner;
			let inputImages = this.ctx.pendingImages.length > 0 ? [...this.ctx.pendingImages] : undefined;

			if (runner?.hasHandlers("input")) {
				const result = await runner.emitInput(text, inputImages, "interactive");
				if (result?.handled) {
					this.ctx.editor.setText("");
					this.ctx.pendingImages = [];
					return;
				}
				if (result?.text !== undefined) {
					text = result.text.trim();
				}
				if (result?.images !== undefined) {
					inputImages = result.images;
				}
			}

			if (!text) return;

			// Handle built-in slash commands
			const slashResult = await executeBuiltinSlashCommand(text, {
				ctx: this.ctx,
				handleBackgroundCommand: () => this.handleBackgroundCommand(),
			});
			if (slashResult === true) {
				return;
			}
			if (typeof slashResult === "string") {
				// Command handled but returned remaining text to use as prompt
				text = slashResult;
			}

			// Handle skill commands (/skill:name [args]). Enter ⇒ steer (matches the
			// free-text Enter semantics applied a few lines below at the streaming
			// branch). Ctrl+Enter routes through `handleFollowUp` and dispatches the
			// same helper with `"followUp"`.
			if (await this.#invokeSkillCommands(text, inputImages, "steer")) {
				return;
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.ctx.session.isBashRunning) {
						this.ctx.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.ctx.editor.setText(text);
						return;
					}
					this.ctx.editor.addToHistory(text);
					await this.ctx.handleBashCommand(command, isExcluded);
					this.ctx.isBashMode = false;
					this.ctx.updateEditorBorderColor();
					return;
				}
			}

			// Handle python command ($ for normal, $$ for excluded from context)
			if (text.startsWith("$")) {
				const isExcluded = text.startsWith("$$");
				const code = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (code) {
					if (this.ctx.session.isEvalRunning) {
						this.ctx.showWarning("A Python execution is already running. Press Esc to cancel it first.");
						this.ctx.editor.setText(text);
						return;
					}
					this.ctx.editor.addToHistory(text);
					await this.ctx.handlePythonCommand(code, isExcluded);
					this.ctx.isPythonMode = false;
					this.ctx.updateEditorBorderColor();
					return;
				}
			}

			// While loop mode is on, every user-typed prompt becomes the new loop
			// prompt that auto-resubmits after each yield.
			if (this.ctx.loopModeEnabled) {
				this.ctx.loopPrompt = text;
			}

			// Queue input during compaction
			if (this.ctx.session.isCompacting) {
				if (this.ctx.pendingImages.length > 0) {
					this.ctx.showStatus("Compaction in progress. Retry after it completes to send images.");
					return;
				}
				this.ctx.queueCompactionMessage(text, "steer");
				return;
			}

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.ctx.session.isStreaming) {
				this.ctx.editor.addToHistory(text);
				this.ctx.editor.setText("");
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.pendingImages = [];
				// Record the signature so the queued message's eventual delivery
				// (a user-role `message_start` event) leaves any draft the user has
				// typed since queuing intact. Same protection as #783, applied to
				// the streaming/queue path.
				await this.ctx.withLocalSubmission(
					text,
					() => this.ctx.session.prompt(text, { streamingBehavior: "steer", images }),
					{ imageCount: images?.length ?? 0 },
				);
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.ctx.flushPendingBashComponents();

			// Auto-generate a session title while the session is still unnamed.
			// Greetings / acknowledgements / empty input carry no task, so they are
			// skipped deterministically (no model invoked, no download-progress UI)
			// and the session stays unnamed — the next user message gets a fresh
			// chance, so titling defers past "hi" instead of latching onto it.
			if (!this.ctx.sessionManager.getSessionName() && !$env.PI_NO_TITLE && !isLowSignalTitleInput(text)) {
				this.#showTinyTitleDownloadProgress(this.ctx.settings.get("providers.tinyModel"));
				const registry = this.ctx.session.modelRegistry;
				generateSessionTitle(
					text,
					registry,
					this.ctx.settings,
					this.ctx.session.sessionId,
					this.ctx.session.model,
					provider => this.ctx.session.agent.metadataForProvider(provider),
				)
					.then(async title => {
						// Re-check: a concurrent attempt for an earlier message may have
						// already named the session. Don't clobber it.
						if (title && !this.ctx.sessionManager.getSessionName()) {
							const applied = await this.ctx.sessionManager.setSessionName(title, "auto");
							if (applied) {
								setSessionTerminalTitle(
									this.ctx.sessionManager.getSessionName()!,
									this.ctx.sessionManager.getCwd(),
								);
								this.ctx.updateEditorBorderColor();
							}
						}
					})
					.catch(() => {});
			}

			if (this.ctx.onInputCallback) {
				// Include any pending images from clipboard paste
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.pendingImages = [];

				// Render user message immediately, then let session events catch up
				const submission = this.ctx.startPendingSubmission({ text, images });

				this.ctx.onInputCallback(submission);
			}
			this.ctx.editor.addToHistory(text);
		};
	}

	handleCtrlC(): void {
		const now = Date.now();
		if (now - this.ctx.lastSigintTime < 500) {
			void this.ctx.shutdown();
		} else {
			this.ctx.clearEditor();
			this.ctx.lastSigintTime = now;
		}
	}

	handleCtrlD(): void {
		// Editor text (if any) is snapshotted at the start of shutdown() and
		// persisted as a draft for the next resume. Empty text is also fine —
		// shutdown clears any stale sidecar in that case.
		void this.ctx.shutdown();
	}

	handleCtrlZ(): void {
		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			this.ctx.ui.start();
			this.ctx.ui.requestRender(true);
		});

		// Stop the TUI (restore terminal to normal mode)
		this.ctx.ui.stop();

		// Send SIGTSTP to process group (pid=0 means all processes in group)
		process.kill(0, "SIGTSTP");
	}

	handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.ctx.showStatus("No queued messages to restore");
		} else {
			this.ctx.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	/**
	 * Detect every token-boundary `/skill:<name>` reference in `text` whose name
	 * is a registered skill command. The scan runs against a code/markup-masked
	 * copy (via {@link maskNonProse}) so `/skill:` inside inline code spans, fenced
	 * blocks, or XML sections is left as literal text — matching the editor
	 * highlighter and autocomplete, so dispatch never consumes a pasted example.
	 * The token is taken up to the next whitespace and resolved verbatim against
	 * the skill map (so names like `_review` or `foo_` are accepted); trailing
	 * punctuation that is not part of a registered name is trimmed back until the
	 * map matches. Returned in first-occurrence order with source offsets.
	 */
	#collectSkillReferences(text: string): SkillReference[] {
		const refs: SkillReference[] = [];
		// Indices into the masked copy still address `text` (same length); prose
		// regions are byte-identical, so the captured token equals the original.
		const masked = maskNonProse(text);
		const re = /(?<!\S)\/(skill:\S+)/g;
		for (const m of masked.matchAll(re)) {
			let commandName = m[1]!;
			let path = this.ctx.skillCommands?.get(commandName);
			while (!path && commandName.length > "skill:".length && /[^A-Za-z0-9]$/.test(commandName)) {
				commandName = commandName.slice(0, -1);
				path = this.ctx.skillCommands?.get(commandName);
			}
			if (!path) continue;
			const start = m.index ?? 0;
			refs.push({
				commandName,
				name: commandName.slice("skill:".length) || commandName,
				path,
				start,
				end: start + 1 + commandName.length, // "/" + the (possibly trimmed) command name
			});
		}
		return refs;
	}

	/**
	 * The classic single-skill invocation that owns the whole message:
	 * `/skill:<name> [args]` with nothing but whitespace before it. Everything
	 * after the token is the skill's arguments. Returns null for any inline or
	 * multi-reference case so the caller composes a combined prompt instead.
	 */
	#leadingSkillArgs(text: string, refs: SkillReference[]): { ref: SkillReference; args: string } | null {
		if (refs.length !== 1) return null;
		const ref = refs[0]!;
		if (text.slice(0, ref.start).trim() !== "") return null;
		return { ref, args: text.slice(ref.end).trim() };
	}

	/**
	 * Build the skill-prompt CustomMessage for `refs`. A single leading reference
	 * keeps the existing single-skill format (args supported). One or more inline
	 * references load every (deduped) referenced skill and preserve the user's full
	 * prose as the trailing instruction; `details.skills` lists them all for the chip.
	 */
	async #buildSkillInvocation(
		text: string,
		refs: SkillReference[],
	): Promise<{ message: string; details: SkillPromptDetails }> {
		const leading = this.#leadingSkillArgs(text, refs);
		if (leading) {
			return buildSkillPromptMessage({ name: leading.ref.name, filePath: leading.ref.path }, leading.args);
		}
		const seen = new Set<string>();
		const unique: SkillReference[] = [];
		for (const ref of refs) {
			if (seen.has(ref.commandName)) continue;
			seen.add(ref.commandName);
			unique.push(ref);
		}
		const built = await Promise.all(
			unique.map(ref => buildSkillPromptMessage({ name: ref.name, filePath: ref.path }, "")),
		);
		const message = `${built.map(b => b.message).join("\n\n")}\n\n---\n\nUser: ${text.trim()}`;
		const details: SkillPromptDetails = {
			name: built[0]!.details.name,
			path: built[0]!.details.path,
			lineCount: built[0]!.details.lineCount,
			skills: built.map(b => ({ name: b.details.name, path: b.details.path, lineCount: b.details.lineCount })),
		};
		return { message, details };
	}

	/**
	 * Dispatch every recognised `/skill:<name>` reference in `text` through
	 * `promptCustomMessage` using the supplied `streamingBehavior`. Returns true
	 * when at least one registered skill reference was found and dispatched (a
	 * failure to load is surfaced via `showError` but still returns true — the
	 * editor was already cleared, so falling through would double-submit). Returns
	 * false when the text contains no recognised skill reference, so the caller
	 * falls through to plain-text handling with the editor untouched.
	 * `streamingBehavior` is only consulted while the agent is streaming.
	 */
	async #invokeSkillCommands(
		text: string,
		images: ImageContent[] | undefined,
		streamingBehavior: "steer" | "followUp",
	): Promise<boolean> {
		// Explicit bash (`!`) and Python (`$`) command modes own the whole input and
		// are handled after this call, so a `/skill:` token inside such a command
		// (e.g. `! echo /skill:foo`, `$ print("/skill:foo")`) must not be hijacked as
		// a skill reference. Mirror those handlers' `startsWith` checks.
		if (text.startsWith("!") || text.startsWith("$")) return false;
		if (!text.includes("/skill:")) return false;
		const refs = this.#collectSkillReferences(text);
		if (refs.length === 0) return false;
		this.ctx.editor.addToHistory(text);
		this.ctx.editor.setText("");
		// `images` is the caller-resolved set to send alongside the skill prompt —
		// post input-extension on the submit path, so an extension that rewrote or
		// added images is honored instead of the stale clipboard buffer. Clear
		// pendingImages so those consumed chips do not re-attach to the next draft.
		this.ctx.pendingImages = [];
		try {
			const { message, details } = await this.#buildSkillInvocation(text, refs);
			// Images ride in the custom-message content array; the chip display only
			// renders the text parts (SkillMessageComponent#extractText), and both the
			// streaming and non-streaming dispatch paths forward image content.
			const content = images && images.length > 0 ? [{ type: "text" as const, text: message }, ...images] : message;
			// When the agent is streaming, register the compact typed text as the
			// pending-display twin BEFORE dispatching the CustomMessage so
			// AgentSession.#handleAgentEvent can remove the matching display entry
			// when the agent consumes this message (mirrors the user-message path).
			if (this.ctx.session.isStreaming) {
				const tag = this.ctx.session.enqueueCustomMessageDisplay(text, streamingBehavior);
				details.__pendingDisplayTag = tag;
			}
			await this.ctx.session.promptCustomMessage(
				{
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content,
					display: true,
					details,
					attribution: "user",
				},
				{ streamingBehavior },
			);
			if (this.ctx.session.isStreaming) {
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
		} catch (err) {
			this.ctx.showError(`Failed to load skill: ${err instanceof Error ? err.message : String(err)}`);
		}
		return true;
	}

	/** Send editor text as a follow-up message (queued behind current stream). */
	async handleFollowUp(): Promise<void> {
		const text = this.ctx.editor.getText().trim();
		if (!text) return;

		// Compaction first: while compacting, free text gets queued via
		// `queueCompactionMessage`, and `/skill:*` rides the same queue so a
		// skill typed during compaction is not lost or short-circuited through
		// `promptCustomMessage`. The skill text is queued verbatim; whether
		// the queued entry is later re-parsed into a skill invocation is a
		// separate concern owned by the compaction-resume path.
		if (this.ctx.session.isCompacting) {
			this.ctx.queueCompactionMessage(text, "followUp");
			return;
		}

		// Skill commands invoke through the custom-message path regardless of
		// which keybinding submitted them. Enter routes them as `steer`;
		// Ctrl+Enter (this handler) routes them as `followUp`.
		if (
			await this.#invokeSkillCommands(
				text,
				this.ctx.pendingImages.length > 0 ? [...this.ctx.pendingImages] : undefined,
				"followUp",
			)
		) {
			return;
		}

		if (this.ctx.session.isStreaming) {
			this.ctx.editor.addToHistory(text);
			this.ctx.editor.setText("");
			await this.ctx.withLocalSubmission(text, () =>
				this.ctx.session.prompt(text, { streamingBehavior: "followUp" }),
			);
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.ui.requestRender();
			return;
		}

		// Not streaming — just submit normally
		this.ctx.editor.addToHistory(text);
		this.ctx.editor.setText("");
		await this.ctx.withLocalSubmission(text, () => this.ctx.session.prompt(text));
	}

	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		this.ctx.locallySubmittedUserSignatures.clear();
		const { steering, followUp } = this.ctx.session.clearQueue();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.ctx.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.ctx.session.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.ctx.editor.getText();
		const combinedText = [queuedText, currentText].filter(t => t.trim()).join("\n\n");
		this.ctx.editor.setText(combinedText);
		this.ctx.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.ctx.session.abort();
		}
		return allQueued.length;
	}

	handleBackgroundCommand(): void {
		if (this.ctx.isBackgrounded) {
			this.ctx.showStatus("Background mode already enabled");
			return;
		}
		if (!this.ctx.session.isStreaming && this.ctx.session.queuedMessageCount === 0) {
			this.ctx.showWarning("Agent is idle; nothing to background");
			return;
		}
		if (this.ctx.hasActiveBtw()) {
			this.ctx.handleBtwEscape();
		}
		if (this.ctx.hasActiveOmfg()) {
			this.ctx.handleOmfgEscape();
		}

		this.ctx.isBackgrounded = true;
		const backgroundUiContext = this.ctx.createBackgroundUiContext();

		// Background mode disables interactive UI so tools like ask fail fast.
		this.ctx.setToolUIContext(backgroundUiContext, false);
		this.ctx.initializeHookRunner(backgroundUiContext, false);

		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		if (this.ctx.autoCompactionLoader) {
			this.ctx.autoCompactionLoader.stop();
			this.ctx.autoCompactionLoader = undefined;
		}
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
		}
		this.ctx.statusContainer.clear();
		this.ctx.statusLine.dispose();

		if (this.ctx.unsubscribe) {
			this.ctx.unsubscribe();
		}
		this.ctx.unsubscribe = this.ctx.session.subscribe(async (event: AgentSessionEvent) => {
			await this.ctx.handleBackgroundEvent(event);
		});

		// Backgrounding keeps the current process to preserve in-flight agent state.
		if (this.ctx.isInitialized) {
			this.ctx.ui.stop();
			this.ctx.isInitialized = false;
		}

		process.stdout.write("Background mode enabled. Run `bg` to continue in background.\n");

		if (process.platform === "win32" || !process.stdout.isTTY) {
			process.stdout.write("Backgrounding requires POSIX job control; continuing in foreground.\n");
			return;
		}

		process.kill(0, "SIGTSTP");
	}

	async handleImagePaste(): Promise<boolean> {
		try {
			const image = await readImageFromClipboard();
			if (image) {
				const base64Data = image.data.toBase64();
				let imageData = await ensureSupportedImageInput({
					type: "image",
					data: base64Data,
					mimeType: image.mimeType,
				});
				if (!imageData) {
					this.ctx.showStatus(`Unsupported clipboard image format: ${image.mimeType}`);
					return false;
				}
				if (settings.get("images.autoResize")) {
					try {
						const resized = await resizeImage({
							type: "image",
							data: imageData.data,
							mimeType: imageData.mimeType,
						});
						imageData = { type: "image", data: resized.data, mimeType: resized.mimeType };
					} catch {
						// Keep the normalized image when resize fails.
					}
				}

				this.ctx.pendingImages.push({
					type: "image",
					data: imageData.data,
					mimeType: imageData.mimeType,
				});
				// Insert placeholder at cursor like Claude does
				const imageNum = this.ctx.pendingImages.length;
				const placeholder = `[Image #${imageNum}]`;
				this.ctx.editor.insertText(`${placeholder} `);
				this.ctx.ui.requestRender();
				return true;
			}
			// No image in clipboard - show hint
			this.ctx.showStatus("No image in clipboard (use terminal paste for text)");
			return false;
		} catch {
			this.ctx.showStatus("Failed to read clipboard");
			return false;
		}
	}

	async handleClipboardTextRawPaste(): Promise<void> {
		try {
			const text = await readTextFromClipboard();
			if (text) {
				this.ctx.editor.insertText(text);
				this.ctx.ui.requestRender();
				this.ctx.showStatus("No text in clipboard to paste raw");
			}
		} catch {
			this.ctx.showStatus("Failed to paste raw text from clipboard");
		}
	}

	createAutocompleteProvider(commands: SlashCommand[], basePath: string): AutocompleteProvider {
		return createPromptActionAutocompleteProvider({
			commands,
			basePath,
			keybindings: this.ctx.keybindings,
			copyCurrentLine: () => this.handleCopyCurrentLine(),
			copyPrompt: () => this.handleCopyPrompt(),
			undo: prefix => this.ctx.editor.undoPastTransientText(prefix),
			moveCursorToMessageEnd: () => this.ctx.editor.moveToMessageEnd(),
			moveCursorToMessageStart: () => this.ctx.editor.moveToMessageStart(),
			moveCursorToLineStart: () => this.ctx.editor.moveToLineStart(),
			moveCursorToLineEnd: () => this.ctx.editor.moveToLineEnd(),
		});
	}

	/** Copy the current editor line to the system clipboard. */
	handleCopyCurrentLine(): void {
		const { line } = this.ctx.editor.getCursor();
		const text = this.ctx.editor.getLines()[line] || "";
		if (!text) {
			this.ctx.showStatus("Nothing to copy");
			return;
		}
		try {
			copyToClipboard(text);
			const sanitized = sanitizeText(text);
			const preview = sanitized.length > 30 ? `${sanitized.slice(0, 30)}...` : sanitized;
			this.ctx.showStatus(`Copied line: ${preview}`);
		} catch {
			this.ctx.showWarning("Failed to copy to clipboard");
		}
	}

	/** Copy current prompt text to system clipboard. */
	handleCopyPrompt(): void {
		const text = this.ctx.editor.getText();
		if (!text) {
			this.ctx.showStatus("Nothing to copy");
			return;
		}
		try {
			copyToClipboard(text);
			const sanitized = sanitizeText(text);
			const preview = sanitized.length > 30 ? `${sanitized.slice(0, 30)}...` : sanitized;
			this.ctx.showStatus(`Copied: ${preview}`);
		} catch {
			this.ctx.showWarning("Failed to copy to clipboard");
		}
	}

	cycleThinkingLevel(): void {
		const newLevel = this.ctx.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.ctx.showStatus("Current model does not support thinking");
		} else {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		}
	}

	async cycleRoleModel(direction: "forward" | "backward" = "forward"): Promise<void> {
		try {
			const cycleOrder = settings.get("cycleOrder");
			const result = await this.ctx.session.cycleRoleModels(cycleOrder, direction);
			if (!result) {
				this.ctx.showStatus("Only one role model available");
				return;
			}

			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			// The status line already reports the resolved model + thinking level, so
			// the cycle status is just a status-line-style chip track (active role
			// filled), matching the plan-approval model slider.
			const track = renderSegmentTrack(
				cycleOrder.map(role => ({ label: role, color: getRoleInfo(role, settings).color })),
				cycleOrder.indexOf(result.role),
			);
			this.ctx.showStatus(track, { dim: false });
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.ctx.toolOutputExpanded);
	}

	setToolsExpanded(expanded: boolean): void {
		this.ctx.toolOutputExpanded = expanded;
		for (const child of this.ctx.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		this.ctx.ui.requestRender(false, { allowUnknownViewportMutation: true });
	}

	toggleThinkingBlockVisibility(): void {
		this.ctx.hideThinkingBlock = !this.ctx.hideThinkingBlock;
		settings.set("hideThinkingBlock", this.ctx.hideThinkingBlock);
		this.ctx.session.agent.hideThinkingSummary = this.ctx.hideThinkingBlock;

		// Rebuild chat from session messages
		this.ctx.chatContainer.clear();
		this.ctx.rebuildChatFromMessages();

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.ctx.streamingComponent && this.ctx.streamingMessage) {
			this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.hideThinkingBlock);
			this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);
			this.ctx.chatContainer.addChild(this.ctx.streamingComponent);
		}

		this.ctx.showStatus(`Thinking blocks: ${this.ctx.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	#getEditorTerminalPath(): string | null {
		if (process.platform === "win32") {
			return null;
		}
		return "/dev/tty";
	}

	async #openEditorTerminalHandle(): Promise<fs.FileHandle | null> {
		const terminalPath = this.#getEditorTerminalPath();
		if (!terminalPath) {
			return null;
		}
		try {
			return await fs.open(terminalPath, "r+");
		} catch {
			return null;
		}
	}

	async openExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.ctx.editor.getExpandedText?.() ?? this.ctx.editor.getText();

		let ttyHandle: fs.FileHandle | null = null;
		try {
			ttyHandle = await this.#openEditorTerminalHandle();
			this.ctx.ui.stop();

			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = ttyHandle
				? [ttyHandle.fd, ttyHandle.fd, ttyHandle.fd]
				: ["inherit", "inherit", "inherit"];

			const result = await openInEditor(editorCmd, currentText, { extension: ".omp.md", stdio });
			if (result !== null) {
				this.ctx.editor.setText(result);
			}
		} catch (error) {
			this.ctx.showWarning(
				`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (ttyHandle) {
				await ttyHandle.close();
			}

			this.ctx.ui.start();
			this.ctx.ui.requestRender();
		}
	}

	registerExtensionShortcuts(): void {
		const runner = this.ctx.session.extensionRunner;
		if (!runner) return;

		const shortcuts = runner.getShortcuts();
		for (const [keyId, shortcut] of shortcuts) {
			this.ctx.editor.setCustomKeyHandler(keyId, () => {
				const ctx = runner.createCommandContext();
				try {
					shortcut.handler(ctx);
				} catch (err) {
					runner.emitError({
						extensionPath: shortcut.extensionPath,
						event: "shortcut",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			});
		}
	}
}
