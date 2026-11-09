import { realpathSync } from "node:fs";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { classifyCallStatus, formatDurationMs, normalizeLineEndings, type RowStatus } from "./compact-tools-core.ts";
import { loadConfig } from "./compact-tools-config.ts";
import { paletteOf } from "./compact-tools-color.ts";
import { hasAuthorRenderers, loadNativeTimerRenderers, syncNativeToolTimer } from "./compact-tools-rendering.ts";
import { registerCompactToolsCommand } from "./compact-tools-command.ts";
import { clearRowResolver, installToolRowPatch, setRowResolver, type RowRenderers, type ToolRow } from "./compact-tools-custom.ts";
import {
	formatResultLineSummary,
	getEditDiff,
	getEditPatch,
	getFileOutput,
	readStartLine,
	getTextResult,
	isReadTextResult,
	splitReadFooter,
} from "./compact-tools-invocation.ts";
import {
	CachedContainer,
	claudeRows,
	LiveCallContainer,
	limitComponentLines,
	prefixedSentence,
	prefixedText,
	railComponent,
	withOutputPad,
	renderArguments,
	renderCodeDiff,
	renderCodeView,
	renderOutput,
	renderToolCall,
	styleMultiline,
	WithinWidth,
} from "./compact-tools-layout.ts";
import {
	CLAUDE_DIFF_CONTEXT_LINES,
	CLAUDE_INDENT,
	CLAUDE_OUTPUT_ROWS,
	CLAUDE_RESULT_PREFIX,
	CLAUDE_RUNNING_OUTPUT_ROWS,
	CLAUDE_TITLE_INDENT,
	CLAUDE_WRITE_ROWS,
	claudeFailure,
	claudeOutcome,
	claudeTitle,
	highlightClaudeOutputLine,
	highlightClaudeShellCommand,
} from "./compact-tools-claude.ts";
import { NestedCallSummaries } from "./compact-tools-nested.ts";
import { ToolGroupController } from "./compact-tools-grouping.ts";
import { chromePainter, completionPainter, paintIndicator } from "./compact-tools-palette.ts";
import { ProgressController } from "./compact-tools-progress.ts";
import { showReleaseNotice } from "./compact-tools-release.ts";
import { ToolRuntime } from "./compact-tools-runtime.ts";
import { SilentModeController } from "./compact-tools-silent.ts";
import { attemptUI, createTranscriptRenderer, type UIFailure } from "./compact-tools-transcript.ts";
import { ThinkingCycleController } from "./compact-tools-thinking.ts";
import { ViewportKeeper } from "./compact-tools-viewport.ts";
import {
	SUPPORTED_TOOL_SET,
	toolExpandKey,
	type CompactToolName,
	type RenderContext,
	type RowState,
	type ToolArgs,
} from "./compact-tools-types.ts";

const runtime = new ToolRuntime();
const nestedSummaries = new NestedCallSummaries();
let registeredConfiguration: string | undefined;
const TRUST_KEY = Symbol.for("pi-compact-tools.trust");
type TrustSlot = typeof globalThis & { [TRUST_KEY]?: { cwd: string; trusted: boolean } };

function realDirectory(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

type RowKind = "file" | "shell" | "custom";
type AuthorResultRenderer = (expanded: boolean) => Component | undefined;

function rowKind(name: string): RowKind {
	return name === "bash" || name === "powershell" ? "shell" : SUPPORTED_TOOL_SET.has(name) ? "file" : "custom";
}

function pathArgument(args: ToolArgs): string {
	return typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
}

function callStatus(ctx: RenderContext, state: RowState): RowStatus {
	const active = runtime.canRun(ctx.toolCallId) && (ctx.executionStarted || !ctx.argsComplete);
	return classifyCallStatus(ctx.isError, active, state.finished === true || state.endedAt !== undefined);
}

function liveIndicator(theme: Theme, ctx: RenderContext, state: RowState): () => string {
	let settled: string | undefined;
	return () => {
		if (settled !== undefined) return settled;
		const status = callStatus(ctx, state);
		const indicator = paintIndicator(theme, status,
			runtime.syncIndicator(ctx.toolCallId, status === "running", () => ctx.invalidate()));
		if (status === "success" || status === "error") settled = indicator;
		return indicator;
	};
}

function formatDuration(state: RowState): string | undefined {
	if (state.durationMs !== undefined) return formatDurationMs(state.durationMs);
	if (state.startedAt === undefined) return undefined;
	return formatDurationMs((state.endedAt ?? Date.now()) - state.startedAt);
}

function canReuseResult<TArgs>(
	state: RowState,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	ctx: RenderContext<TArgs>,
): ctx is RenderContext<TArgs> & { lastComponent: Component } {
	return ctx.lastComponent !== undefined
		&& state.lastResultContent === result.content
		&& state.lastResultDetails === result.details
		&& state.lastResultPartial === options.isPartial
		&& state.lastResultExpanded === state.expanded
		&& state.lastResultError === ctx.isError
		&& state.lastResultConfigRevision === state.configRevision
		&& state.lastResultPalette === paletteOf(theme)
		&& state.lastResultDurationMs === state.durationMs
		&& state.lastResultOutputPad === ctx.outputPad
		&& state.lastResultExpandKey === toolExpandKey(ctx);
}

function rememberResult(state: RowState, result: AgentToolResult<unknown>, options: ToolRenderResultOptions, isError: boolean, theme: Theme): void {
	state.lastResultContent = result.content;
	state.lastResultDetails = result.details;
	state.lastResultPartial = options.isPartial;
	state.lastResultExpanded = state.expanded;
	state.lastResultError = isError;
	state.lastResultConfigRevision = state.configRevision;
	state.lastResultPalette = paletteOf(theme);
}

function renderControls(
	theme: Theme,
	state: RowState,
	running: boolean,
	isError: boolean,
	nestedSummary?: string,
	prefix = CLAUDE_INDENT,
	indent = CLAUDE_INDENT,
): Component {
	const duration = running ? undefined : formatDuration(state);
	const status = running
		? (duration ?? "Running")
		: `${isError ? "Failed" : "Done"}${duration ? ` in ${duration}` : ""}`;
	const chrome = chromePainter(theme);
	const metadata = running ? chrome : completionPainter(theme);
	let details = metadata(status);
	if (state.resultLineSummary && !running && !isError) details += metadata(` (${state.resultLineSummary})`);
	if (nestedSummary && !running) details += chrome(" · ") + nestedSummary;
	return nestedSummary ? prefixedSentence(details, chrome(prefix), indent, true) : prefixedText(details, chrome(prefix), indent);
}

function hasNestedArguments(args: ToolArgs): boolean {
	return Object.values(args).some((value) => typeof value === "object" && value !== null
		&& (!Array.isArray(value) || value.some((item) => typeof item === "object" && item !== null)));
}

function renderRowCall(name: string, args: ToolArgs, theme: Theme, ctx: RenderContext): Component {
	return withOutputPad(renderRowCallContent(name, args, theme, ctx), ctx.outputPad);
}

function renderRowCallContent(name: string, args: ToolArgs, theme: Theme, ctx: RenderContext): Component {
	const state = runtime.syncRow(ctx);
	runtime.syncExpansion(state, ctx.expanded, name);
	const kind = rowKind(name);
	const indicator = liveIndicator(theme, ctx, state);
	indicator();
	const { label, argument } = claudeTitle(name, args, state.expanded === true);
	const styledArgument = argument
		? kind === "shell"
			? `${theme.fg("syntaxPunctuation", "(")}${highlightClaudeShellCommand(argument, theme)}${theme.fg("syntaxPunctuation", ")")}`
			: styleMultiline(`(${argument})`, (line) => theme.fg("toolOutput", line))
		: "";
	const title = ` ${theme.fg("toolTitle", theme.bold(label))}${styledArgument}`;
	const container = new LiveCallContainer(indicator, (dot) => renderToolCall(dot + title, undefined, theme, CLAUDE_TITLE_INDENT));
	if (kind === "custom" && state.expanded && hasNestedArguments(args)) container.addChild(renderArguments(args, theme, CLAUDE_INDENT));
	return new WithinWidth(container);
}

function renderFileBody(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	output: string,
	theme: Theme,
	isError: boolean,
	rail?: string,
): Component | undefined {
	const fallback = () => renderOutput(output, theme, isError, rail);
	if (isError) return fallback();
	const path = pathArgument(args);
	if (name === "edit" && getEditDiff(result)) {
		return renderCodeDiff(getEditPatch(result), getEditDiff(result), path, theme, { rail }) ?? fallback();
	}
	if (name === "read" && isReadTextResult(result)) {
		const { body, footer } = splitReadFooter(output);
		const startLine = readStartLine(args.offset);
		return renderCodeView(body, path, theme, { startLine, footer, rail }) ?? fallback();
	}
	if (name === "write") return renderCodeView(output, path, theme, { rail }) ?? fallback();
	return fallback();
}

function renderRowBody(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	output: string,
	expanded: boolean,
	theme: Theme,
	isError: boolean,
	author: AuthorResultRenderer | undefined,
	rail?: string,
): Component | undefined {
	if (!author && rowKind(name) !== "custom") return renderFileBody(name, args, result, output, theme, isError, rail);
	if (author) {
		try {
			const component = author(expanded);
			if (component) return railComponent(component, theme, rail);
		} catch {
			// A failing third-party renderer degrades to the plain text result.
		}
	}
	return renderOutput(output, theme, isError, rail);
}

function claudeMoreLines(theme: Theme, hidden: number, expandKey: string): string {
	return chromePainter(theme)(`… +${hidden} ${hidden === 1 ? "line" : "lines"}${expandKey ? ` (${expandKey} to expand)` : ""}`);
}

function claudeOutput(output: string, expanded: boolean, theme: Theme, isError: boolean, empty: string, firstPrefix: string, completion: Component | undefined, expandKey: string): Component {
	const normalized = normalizeLineEndings(output).trimEnd();
	const lines = !normalized || normalized === "(no output)"
		? [chromePainter(theme)(empty)]
		: normalized.split("\n").map((line) => isError ? theme.fg("error", line) : highlightClaudeOutputLine(line, theme));
	return claudeRows(lines, firstPrefix, CLAUDE_INDENT, expanded ? undefined : CLAUDE_OUTPUT_ROWS,
		(hidden) => claudeMoreLines(theme, hidden, expandKey), completion);
}

function claudeBody(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	output: string,
	expanded: boolean,
	theme: Theme,
	author: AuthorResultRenderer | undefined,
	expandKey: string,
): Component | undefined {
	if (author && expanded) return renderRowBody(name, args, result, output, true, theme, false, author, CLAUDE_INDENT);
	const path = pathArgument(args);
	if (name === "edit") {
		return renderCodeDiff(getEditPatch(result), getEditDiff(result), path, theme,
			{ contextLines: CLAUDE_DIFF_CONTEXT_LINES, rail: CLAUDE_INDENT });
	}
	if (name === "write") {
		const component = renderCodeView(output, path, theme, { rail: CLAUDE_INDENT });
		return component && !expanded
			? limitComponentLines(component, CLAUDE_WRITE_ROWS, theme, (hidden) => CLAUDE_INDENT + claudeMoreLines(theme, hidden, expandKey))
			: component;
	}
	const kind = rowKind(name);
	if (!expanded || kind === "shell" || name === "read") return undefined;
	if (kind === "custom") return author ? renderRowBody(name, args, result, output, true, theme, false, author, CLAUDE_INDENT) : undefined;
	return renderFileBody(name, args, result, output, theme, false, CLAUDE_INDENT);
}

function renderClaudeResult(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
	expanded: boolean,
	output: string,
	author: AuthorResultRenderer | undefined,
	completion: Component | undefined,
	expandKey: string,
): Component {
	const chrome = chromePainter(theme);
	const container = new CachedContainer();
	const line = (text: string) => prefixedSentence(text, chrome(CLAUDE_RESULT_PREFIX), CLAUDE_INDENT);
	if (options.isPartial) {
		const partial = normalizeLineEndings(output).trimEnd();
		if (rowKind(name) === "shell" && partial && partial !== "(no output)") {
			container.addChild(claudeRows(partial.split("\n").map((row) => highlightClaudeOutputLine(row, theme)),
				chrome(CLAUDE_RESULT_PREFIX), CLAUDE_INDENT, expanded ? undefined : CLAUDE_RUNNING_OUTPUT_ROWS,
				(hidden) => chrome(`+${hidden} lines`), undefined, true));
		} else container.addChild(line(chrome("Running…")));
		return container;
	}
	if (isError) {
		const failure = claudeFailure(name, output, expanded);
		container.addChild(line(styleMultiline(failure.headline, (row) => theme.fg("error", row))));
		if (failure.detail) {
			container.addChild(claudeOutput(failure.detail, expanded, theme, true, "", CLAUDE_INDENT, completion, expandKey));
		} else if (completion) container.addChild(completion);
		return container;
	}
	const body = claudeBody(name, args, result, output, expanded, theme, author, expandKey);
	const outcome = body && rowKind(name) === "custom"
		? formatResultLineSummary(name, args, result, output) ?? "Done"
		: claudeOutcome(name, args, result, output, (value) => theme.bold(value));
	if (outcome !== undefined) container.addChild(line(theme.fg("toolOutput", outcome)));
	else container.addChild(claudeOutput(output, expanded, theme, false, rowKind(name) === "shell" ? "(No output)" : "(No content)", chrome(CLAUDE_RESULT_PREFIX), completion, expandKey));
	if (body) container.addChild(body);
	if (completion && outcome !== undefined) container.addChild(completion);
	return container;
}

function renderRowResult(
	name: string,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	ctx: RenderContext,
	author?: AuthorResultRenderer,
	watchNested = true,
): Component {
	const state = runtime.syncRow(ctx, !options.isPartial);
	runtime.syncExpansion(state, ctx.expanded, name);
	if (canReuseResult(state, result, options, theme, ctx)) return ctx.lastComponent;
	const kind = rowKind(name);
	const output = kind === "file" && !author ? getFileOutput(name, ctx.args, result, ctx.isError) : getTextResult(result);
	const hasEditDiff = name === "edit" && getEditDiff(result).length > 0;
	runtime.setResultAvailable(state, name, hasEditDiff || output.length > 0 || author !== undefined);
	const nestedSummary = name === "codemode" && !options.isPartial ? nestedSummaries.format(ctx.toolCallId, theme, state.expanded === true) : undefined;
	if (nestedSummary && !state.resultLineSummaryComputed) {
		state.resultLineSummary = output ? formatResultLineSummary(name, ctx.args, result, output) : undefined;
		state.resultLineSummaryComputed = true;
	}
	const container = new CachedContainer();
	const completion = nestedSummary ? renderControls(theme, state, false, ctx.isError, nestedSummary, CLAUDE_INDENT, CLAUDE_INDENT) : undefined;
	container.addChild(renderClaudeResult(name, ctx.args, result, options, theme, ctx.isError, state.expanded === true, output, author, completion, toolExpandKey(ctx)));
	const component = new WithinWidth(container);
	rememberResult(state, result, options, ctx.isError, theme);
	state.lastResultDurationMs = state.durationMs;
	state.lastResultOutputPad = ctx.outputPad;
	state.lastResultExpandKey = toolExpandKey(ctx);
	let drawn = withOutputPad(component, ctx.outputPad);
	if (name !== "codemode" || options.isPartial || !watchNested) return drawn;
	let revision = nestedSummaries.revision(ctx.toolCallId);
	return {
		render(width) {
			const next = nestedSummaries.revision(ctx.toolCallId);
			if (next !== revision) {
				revision = next;
				drawn = renderRowResult(name, result, options, theme, { ...ctx, lastComponent: undefined }, author, false);
			}
			return drawn.render(width);
		},
		invalidate() { drawn.invalidate(); },
	};
}

let authorStates = new WeakMap<object, { state: RowState; component?: Component }>();
function createCustomRenderers(name: string, author: ToolDefinition<any, any, any> | undefined): RowRenderers {
	const slot = (ctx: RenderContext<any>) => {
		let value = authorStates.get(ctx.state);
		if (!value) authorStates.set(ctx.state, value = { state: {} });
		return value;
	};
	const own = (ctx: RenderContext<any>): RenderContext => ({ ...ctx, args: ctx.args ?? {}, state: slot(ctx).state });
	return {
		renderCall: (args, theme, ctx) => renderRowCall(name, (args ?? {}) as ToolArgs, theme, own(ctx)),
		renderResult: (result, options, theme, ctx) => {
			const authorRenderer = author?.renderResult;
			const renderAuthorResult = authorRenderer
				? (expanded: boolean) => {
					const value = slot(ctx);
					try {
						value.component = authorRenderer(result, { ...options, expanded }, theme, {
							...ctx, lastComponent: value.component, ...((ctx as { outputPad?: number }).outputPad === undefined ? {} : { outputPad: 0 }),
						});
					} finally {
						syncNativeToolTimer({ rendererState: ctx.state }, name, author, false);
					}
					return value.component;
				}
				: undefined;
			return renderRowResult(name, result, options, theme, own(ctx), renderAuthorResult);
		},
	};
}

let builtinStates = new WeakMap<object, RowState>();
const compactRendererDefinitions = new WeakSet<object>();
function builtinContext(ctx: RenderContext): RenderContext {
	let state = builtinStates.get(ctx.state);
	if (!state) builtinStates.set(ctx.state, state = {});
	return { ...ctx, state };
}

function resolveCustomRow(row: ToolRow): RowRenderers | undefined {
	if (runtime.config.style === "off") return undefined;
	const customTools = runtime.config.custom_tools;
	if (SUPPORTED_TOOL_SET.has(row.toolName) && (!row.toolDefinition || compactRendererDefinitions.has(row.toolDefinition) || (row.toolDefinition.renderResult && compactRendererDefinitions.has(row.toolDefinition.renderResult)) || !hasAuthorRenderers(row.toolName, row.toolDefinition))) {
		if (!runtime.config.tools.includes(row.toolName as CompactToolName)) return undefined;
		const renderers: RowRenderers = {
			renderCall: (args, theme, ctx) => renderRowCall(row.toolName, (args ?? {}) as ToolArgs, theme, builtinContext(ctx as RenderContext)),
			renderResult: (result, options, theme, ctx) => renderRowResult(row.toolName, result, options, theme, builtinContext(ctx as RenderContext)),
		};
		compactRendererDefinitions.add(renderers);
		compactRendererDefinitions.add(renderers.renderResult);
		return renderers;
	}
	if (!customTools.enabled || customTools.exclude.includes(row.toolName)) return undefined;
	return createCustomRenderers(row.toolName, row.toolDefinition);
}

type RendererAPI = ExtensionAPI & {
	registerToolRenderer?: (resolver: (name: string, next: () => ToolDefinition<any, any, any> | undefined) => ToolDefinition<any, any, any> | undefined) => void;
};
let publicRendering = false;
let sessionReady = false;
let publicBases = new WeakMap<object, ToolDefinition<any, any, any> | undefined>();
let publicOwners = new WeakMap<object, { call?: unknown; result?: unknown }>();
function publicRowDefinition(name: string, base: ToolDefinition<any, any, any> | undefined): ToolDefinition<any, any, any> | undefined {
	let config: unknown;
	let decision: RowRenderers | undefined;
	const decide = () => {
		if (config !== runtime.config) {
			config = runtime.config;
			decision = resolveCustomRow({ toolName: name, toolDefinition: base });
		}
		return decision;
	};
	if (!decide() && (sessionReady || !base)) return base;
	const context = (ctx: Parameters<RowRenderers["renderCall"]>[2], kind: "call" | "result", render: unknown): typeof ctx => {
		let owner = publicOwners.get(ctx.state);
		if (!owner) publicOwners.set(ctx.state, owner = {});
		const changed = owner[kind] !== render;
		owner[kind] = render;
		return changed ? { ...ctx, lastComponent: undefined } : ctx;
	};
	const call: RowRenderers["renderCall"] = (args, theme, ctx) => {
		const render = decide()?.renderCall ?? base?.renderCall;
		return render!(args, theme, context(ctx, "call", render));
	};
	const result: RowRenderers["renderResult"] = (value, options, theme, ctx) => {
		const render = decide()?.renderResult ?? base?.renderResult;
		return render!(value, options, theme, context(ctx, "result", render));
	};
	const definition = {
		get renderShell() { return decide() ? "self" : base?.renderShell ?? "default"; },
		get renderCall() { return decide()?.renderCall || base?.renderCall ? call : undefined; },
		get renderResult() { return decide()?.renderResult || base?.renderResult ? result : undefined; },
	} as ToolDefinition<any, any, any>;
	publicBases.set(definition, base);
	return definition;
}
let legacyResolver: ((row: ToolRow) => RowRenderers | undefined) | undefined;
let refreshTranscriptRows: ((failures: UIFailure[]) => void) | undefined;
function invalidateRowDecisions(failures: UIFailure[]): void {
	if (!publicRendering) {
		legacyResolver = (row) => resolveCustomRow(row);
		setRowResolver(legacyResolver);
	}
	refreshTranscriptRows?.(failures);
}

function configure(_pi: ExtensionAPI, cwd?: string, projectTrusted = false, failures: UIFailure[] = []): void {
	const resolvedCwd = cwd ?? process.cwd();
	const config = loadConfig(resolvedCwd, projectTrusted);
	const signature = JSON.stringify([resolvedCwd, config]);
	if (signature === registeredConfiguration) return;
	runtime.configure(config);
	registeredConfiguration = signature;
	invalidateRowDecisions(failures);
}

function applyStyle(cwd: string, trusted: boolean, failures: UIFailure[]): boolean {
	const config = loadConfig(cwd, trusted);
	const current = runtime.config;
	if (JSON.stringify({ ...config, style: current.style }) !== JSON.stringify(current)) return false;
	runtime.configure(config);
	registeredConfiguration = JSON.stringify([cwd, config]);
	invalidateRowDecisions(failures);
	return true;
}

function noteCalls(message: unknown): void {
	const content = (message as { role?: string; content?: unknown }).role === "assistant"
		? (message as { content?: unknown }).content
		: undefined;
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (block?.type === "toolCall" && typeof block.id === "string") runtime.noteCall(block.id);
	}
}

function madeByTool(event: object): boolean {
	return typeof (event as { parentToolCallId?: unknown }).parentToolCallId === "string";
}

export default function compactTools(pi: ExtensionAPI): void {
	registeredConfiguration = undefined;
	refreshTranscriptRows = undefined;
	sessionReady = false;
	publicOwners = new WeakMap();
	publicBases = new WeakMap();
	const thinkingCycle = new ThinkingCycleController(pi, () => runtime.config.style !== "off");
	const progress = new ProgressController(pi);
	const viewport = new ViewportKeeper();
	const silent = new SilentModeController(pi, showReleaseNotice);
	const groups = new ToolGroupController(runtime);
	builtinStates = new WeakMap();
	authorStates = new WeakMap();
	const rendererAPI = pi as RendererAPI;
	publicRendering = typeof rendererAPI.registerToolRenderer === "function";
	const customRowsAvailable = publicRendering || installToolRowPatch();
	if (publicRendering) {
		setRowResolver(undefined);
		rendererAPI.registerToolRenderer!((name, next) => {
			const base = next();
			return publicRowDefinition(name, base as ToolDefinition<any, any, any> | undefined);
		});
	} else invalidateRowDecisions([]);
	const transcript = createTranscriptRenderer({
		runtime, publicRendering, resolve: resolveCustomRow, definition: publicRowDefinition,
		unwrap: (current) => current && publicBases.has(current) ? publicBases.get(current) : current,
	});
	refreshTranscriptRows = transcript.refresh;
	let customRowsWarned = false;
	let sessionContext: ExtensionContext | undefined;
	const reportFailures = (ctx: ExtensionContext | undefined, failures: UIFailure[]) => {
		if (ctx && failures.length > 0) {
			const operations = [...new Set(failures.map(failure => failure.operation))].join(", ");
			const message = `Compact tools: UI refresh/cleanup failed (${operations}). The selected style is saved; affected UI may need /reload.`;
			try { ctx.ui.notify(message, "warning"); }
			catch (error) { console.warn(message, "UI notification also failed:", error); }
		}
	};
	const enableUI = (ctx: ExtensionContext, reload: boolean, resume: boolean, failures: UIFailure[]) => {
		attemptUI(failures, "viewport bind", () => viewport.bind(ctx));
		attemptUI(failures, "progress bind", () => progress.bind(ctx, resume));
		attemptUI(failures, "thinking bind", () => thinkingCycle.bind(ctx));
		attemptUI(failures, "silent bind", () => silent.bind(ctx, runtime.config.mode, reload, resume));
		attemptUI(failures, "groups bind", () => groups.bind(ctx));
		transcript.bind(ctx, failures);
	};
	const detachUI = (options: { preservePhase?: boolean; restoreNative?: boolean; clearTimings?: boolean }, failures: UIFailure[]) => {
		attemptUI(failures, "thinking cleanup", () => thinkingCycle.dispose(options.restoreNative));
		attemptUI(failures, "progress cleanup", () => progress.dispose(options.preservePhase));
		attemptUI(failures, "silent cleanup", () => silent.dispose());
		attemptUI(failures, "groups cleanup", () => groups.dispose());
		attemptUI(failures, "viewport cleanup", () => viewport.dispose());
		attemptUI(failures, "animation cleanup", () => runtime.reset(options.clearTimings === true));
		attemptUI(failures, "renderer cleanup", () => transcript.detach());
	};
	registerCompactToolsCommand(pi, () => runtime.config, (cwd, trusted, ctx) => {
		const failures: UIFailure[] = [];
		const wasOff = runtime.config.style === "off";
		if (!applyStyle(cwd, trusted, failures)) return false;
		const uiContext = sessionContext ?? ctx;
		if (uiContext.mode === "tui") {
			if (runtime.config.style === "off") detachUI({ preservePhase: true, restoreNative: true }, failures);
			else if (wasOff) enableUI(uiContext, true, true, failures);
			if (wasOff && runtime.config.style === "off") attemptUI(failures, "native thinking", () => uiContext.ui.setHiddenThinkingLabel());
		}
		reportFailures(uiContext, failures);
		return true;
	});
	const cwd = process.cwd();
	const lastTrust = (globalThis as TrustSlot)[TRUST_KEY];
	configure(pi, cwd, lastTrust?.cwd === realDirectory(cwd) && lastTrust.trusted);
	pi.on("session_start", () => loadNativeTimerRenderers());
	pi.on("session_start", (event, ctx) => {
		const failures: UIFailure[] = [];
		detachUI({ restoreNative: true }, failures);
		sessionContext = ctx;
		if (event.reason !== "reload") {
			runtime.clearTimings();
			nestedSummaries.clear();
		}
		const branch = ctx.sessionManager?.getBranch?.();
		if (Array.isArray(branch)) nestedSummaries.restoreBranch(branch);
		if (typeof ctx.isIdle === "function") runtime.setBusy(!ctx.isIdle());
		const trusted = ctx.isProjectTrusted();
		(globalThis as TrustSlot)[TRUST_KEY] = { cwd: realDirectory(ctx.cwd), trusted };
		configure(pi, ctx.cwd, trusted, failures);
		sessionReady = true;
		if (ctx.mode === "tui" && runtime.config.style !== "off") {
			enableUI(ctx, event.reason === "reload", false, failures);
			if (!silent.isEnabled()) showReleaseNotice(ctx);
			if ((runtime.config.custom_tools.enabled || runtime.config.tools.length > 0) && !customRowsAvailable && !customRowsWarned) {
				customRowsWarned = true;
				ctx.ui.notify("Compact tool rendering is unavailable in this version of Pi", "warning");
			}
		} else if (ctx.mode === "tui") {
			transcript.reconcileOnce(ctx, failures);
		}
		reportFailures(ctx, failures);
	});
	pi.on("session_tree", (_event, ctx) => {
		const branch = ctx.sessionManager?.getBranch?.();
		if (Array.isArray(branch)) nestedSummaries.restoreBranch(branch);
		runtime.repaint();
	});
	pi.on("agent_start", () => runtime.setBusy(true));
	pi.on("agent_end", () => runtime.setBusy(false));
	pi.on("message_update", (event) => noteCalls(event.message));
	pi.on("message_end", (event) => {
		if (nestedSummaries.restore(event.message)) runtime.repaint();
	});
	pi.on("tool_execution_start", (event) => {
		if (madeByTool(event)) {
			nestedSummaries.note(event, false);
			return;
		}
		nestedSummaries.begin(event.toolCallId, event.toolName);
		runtime.noteCall(event.toolCallId);
		runtime.noteExecutionStart(event.toolCallId);
	});
	pi.on("tool_execution_end", (event) => {
		if (madeByTool(event)) {
			if (nestedSummaries.note(event, true)) runtime.repaint();
			return;
		}
		nestedSummaries.finish(event.toolCallId);
		runtime.noteExecutionEnd(event.toolCallId, (event as { durationMs?: number }).durationMs);
	});
	pi.on("session_shutdown", (event) => {
		const failures: UIFailure[] = [];
		detachUI({ clearTimings: event.reason !== "reload" }, failures);
		reportFailures(sessionContext, failures);
		sessionContext = undefined;
		if (event.reason !== "reload") nestedSummaries.clear();
		if (legacyResolver) clearRowResolver(legacyResolver);
		refreshTranscriptRows = undefined;
	});
}
