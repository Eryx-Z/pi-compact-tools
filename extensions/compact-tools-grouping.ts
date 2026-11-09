import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type AgentToolResult,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { CLAUDE_RESULT_PREFIX, claudeFailure, lookHint, lookKind, pathOf, type LookKind } from "./compact-tools-claude.ts";
import { formatDurationMs, type RowStatus } from "./compact-tools-core.ts";
import { hookMethod } from "./compact-tools-hook.ts";
import { getTextResult } from "./compact-tools-invocation.ts";
import { outputPadLines } from "./compact-tools-layout.ts";
import { chromePainter, paintIndicator } from "./compact-tools-palette.ts";
import type { ToolRuntime } from "./compact-tools-runtime.ts";
import { findChat, isKind, isSilent } from "./compact-tools-silent.ts";
import { captureViewport } from "./compact-tools-viewport.ts";
import type { ToolArgs } from "./compact-tools-types.ts";

const WIDGET_KEY = "compact-tools-groups";

const PHRASES: ReadonlyArray<{ kind: LookKind; running: string; done: string; singular: string; plural: string }> = [
	{ kind: "search", running: "searching for", done: "searched for", singular: "pattern", plural: "patterns" },
	{ kind: "read", running: "reading", done: "read", singular: "file", plural: "files" },
	{ kind: "list", running: "listing", done: "listed", singular: "directory", plural: "directories" },
];

export const EXPAND_HINT = "(click to expand)";

export interface ToolRowLike {
	toolName: string;
	toolCallId: string;
	args: unknown;
	result?: AgentToolResult<unknown> & { isError?: boolean };
	isPartial: boolean;
	expanded: boolean;
	outputPad?: number;
	render(width: number): string[];
	handleMouse?(event: unknown): unknown;
	invalidate(): void;
	setExpanded?(expanded: boolean): void;
}

export type CanRun = (row: ToolRowLike) => boolean;

const ALWAYS_RUNS: CanRun = () => true;

export function memberStatus(row: ToolRowLike, canRun: CanRun = ALWAYS_RUNS): RowStatus {
	if (!row.result || row.isPartial) return canRun(row) ? "running" : "pending";
	return row.result.isError ? "error" : "success";
}

function argsOf(row: ToolRowLike): ToolArgs {
	return typeof row.args === "object" && row.args !== null ? row.args as ToolArgs : {};
}

const kinds = new WeakMap<object, { args: unknown; kind: LookKind | undefined }>();

function kindOf(row: ToolRowLike): LookKind | undefined {
	if (row.isPartial) {
		if (row.toolName === "bash" || row.toolName === "powershell") return undefined;
		return lookKind(row.toolName, argsOf(row));
	}
	const cached = kinds.get(row);
	if (cached && cached.args === row.args) return cached.kind;
	const kind = lookKind(row.toolName, argsOf(row));
	kinds.set(row, { args: row.args, kind });
	return kind;
}

function lastRunning(rows: readonly ToolRowLike[], canRun: CanRun): ToolRowLike | undefined {
	for (let index = rows.length - 1; index >= 0; index--) {
		if (memberStatus(rows[index]!, canRun) === "running") return rows[index];
	}
	return undefined;
}

export function countGroup(rows: readonly ToolRowLike[]): Record<LookKind, number> {
	const counts: Record<LookKind, number> = { search: 0, read: 0, list: 0 };
	const paths = new Set<string>();
	let readCommands = 0;
	for (const row of rows) {
		const kind = kindOf(row);
		if (kind === "read" && row.toolName === "read") {
			const p = pathOf(argsOf(row));
			if (p) paths.add(p);
			else readCommands++;
		} else if (kind === "read") readCommands++;
		else if (kind) counts[kind]++;
	}
	counts.read = paths.size + readCommands;
	return counts;
}

export function summarizeGroup(
	rows: readonly ToolRowLike[],
	bold: (text: string) => string = (text) => text,
	canRun: CanRun = ALWAYS_RUNS,
): string {
	const counts = countGroup(rows);
	const running = lastRunning(rows, canRun) !== undefined;
	const text = PHRASES.filter((phrase) => counts[phrase.kind] > 0)
		.map((phrase) => {
			const count = counts[phrase.kind];
			return `${running ? phrase.running : phrase.done} ${bold(String(count))} ${count === 1 ? phrase.singular : phrase.plural}`;
		})
		.join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function groupHint(rows: readonly ToolRowLike[], canRun: CanRun = ALWAYS_RUNS): string | undefined {
	const running = lastRunning(rows, canRun);
	if (!running) return undefined;
	return lookHint(running.toolName, argsOf(running)) || undefined;
}

export function groupFailures(rows: readonly ToolRowLike[]): string[] {
	return rows.filter((row) => memberStatus(row) === "error")
		.map((row) => claudeFailure(row.toolName, getTextResult(row.result!)).headline);
}

type HeaderCache = {
	paint: string;
	width: number;
	expanded: boolean;
	hostExpanded: boolean;
	rows: readonly ToolRowLike[];
	args: unknown[];
	results: unknown[];
	statuses: readonly RowStatus[];
	lines: string[];
};

type GroupState = { expanded: boolean; lastHostExpanded: boolean; header?: HeaderCache };
type Paint = { theme: Theme; chrome: (text: string) => string; key: string };

const PAINT_COLORS = ["toolTitle", "error", "success", "muted", "dim", "text", "borderMuted", "accent"] as const;

function isHostExpanded(rows: readonly ToolRowLike[]): boolean {
	return Boolean(rows[0]?.expanded) && rows.every((row) => Boolean(row.expanded));
}

function headerStill(
	cache: HeaderCache,
	rows: readonly ToolRowLike[],
	statuses: readonly RowStatus[],
	paint: string,
	width: number,
	expanded: boolean,
	hostExpanded: boolean,
): boolean {
	if (cache.paint !== paint || cache.width !== width || cache.expanded !== expanded
		|| cache.hostExpanded !== hostExpanded || cache.rows.length !== rows.length) return false;
	return rows.every((row, index) => row === cache.rows[index] && row.args === cache.args[index]
		&& row.result === cache.results[index] && statuses[index] === cache.statuses[index]);
}

export class ToolGroupComponent extends Container {
	constructor(
		readonly rows: readonly ToolRowLike[],
		members: readonly unknown[],
		private readonly state: GroupState,
		private readonly draw: (rows: readonly ToolRowLike[], width: number, expanded: boolean) => string[],
		private readonly onToggle: (expanded: boolean) => void,
	) {
		super();
		const hostExpanded = isHostExpanded(rows);
		if (state.lastHostExpanded !== hostExpanded) {
			state.lastHostExpanded = hostExpanded;
			state.expanded = hostExpanded;
		}
		const handleMouse = (event: { type?: string; button?: string }) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			captureViewport();
			this.state.expanded = !this.state.expanded;
			this.onToggle(this.state.expanded);
			return { handled: true };
		};
		this.addChild({ render: (width) => this.draw(this.rows, width, this.state.expanded), invalidate() {}, handleMouse } as Component);
		if (!state.expanded) return;
		for (const member of members) this.addChild(member as Component);
	}
}

function isGroupable(child: unknown): child is ToolRowLike {
	if (!isKind(child, ToolExecutionComponent)) return false;
	return kindOf(child as ToolRowLike) !== undefined;
}

type AssistantLike = {
	lastMessage?: {
		stopReason?: string;
		content?: Array<{ type: string; text?: string }>;
	};
};

function isThinkingOnly(child: unknown): boolean {
	if (!isKind(child, AssistantMessageComponent)) return false;
	const assistant = child as AssistantLike;
	const stopReason = assistant.lastMessage?.stopReason;
	if (stopReason === "error" || stopReason === "aborted" || stopReason === "length") return false;
	const content = assistant.lastMessage?.content ?? [];
	return !content.some((block) => block.type === "text" && block.text?.trim());
}

function isFoldable(child: unknown): boolean {
	return isThinkingOnly(child) || isKind(child, Spacer);
}

export function groupChildren(
	children: readonly unknown[],
	makeGroup: (rows: ToolRowLike[], members: unknown[]) => Component,
): unknown[] {
	const grouped: unknown[] = [];
	let rows: ToolRowLike[] = [];
	let members: unknown[] = [];
	let pending: unknown[] = [];
	const flush = () => {
		if (rows.length > 0) grouped.push(makeGroup(rows, members));
		rows = [];
		members = [];
	};
	for (const child of children) {
		if (isGroupable(child)) {
			rows.push(child);
			members.push(...pending, child);
			pending = [];
			continue;
		}
		if (rows.length > 0 && isFoldable(child)) {
			pending.push(child);
			continue;
		}
		flush();
		grouped.push(...pending, child);
		pending = [];
	}
	flush();
	grouped.push(...pending);
	return grouped;
}

export class ToolGroupController {
	private context: ExtensionContext | undefined;
	private unhookChat: (() => void) | undefined;
	private readonly states = new WeakMap<object, GroupState>();
	private paint: Paint | undefined;
	private readonly canRun: CanRun = (row) => this.runtime.canRun(row.toolCallId);

	constructor(private readonly runtime: ToolRuntime) {}

	bind(ctx: ExtensionContext): void {
		this.dispose();
		this.context = ctx;
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			const chat = findChat(tui);
			if (chat) {
				this.unhookChat = hookMethod(chat, "render", "claude.groups", (self, args, original) => {
					if (!this.context || isSilent() || this.runtime.config.style !== "claude") return original.apply(self, args);
					const children = self.children as unknown[];
					this.paint = this.resolvePaint();
					self.children = groupChildren(children, (rows, members) => this.makeGroup(rows, members, tui));
					try {
						return original.apply(self, args);
					} finally {
						self.children = children;
						this.paint = undefined;
					}
				}) || undefined;
			}
			return { render: () => [], invalidate() {} };
		}, { placement: "belowEditor" });
	}

	dispose(): void {
		const context = this.context;
		this.context = undefined;
		this.unhookChat?.();
		this.unhookChat = undefined;
		context?.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
	}

	private makeGroup(rows: ToolRowLike[], members: unknown[], tui: { requestRender(): void }): Component {
		const key = rows[0]!;
		const hostExpanded = isHostExpanded(rows);
		let state = this.states.get(key);
		if (!state) {
			state = { expanded: hostExpanded, lastHostExpanded: hostExpanded };
			this.states.set(key, state);
		}
		const groupState = state;
		const draw = (group: readonly ToolRowLike[], width: number, expanded: boolean) => {
			const pad = group[0]?.outputPad;
			return outputPadLines(this.drawCached(group, width + (pad === 0 ? 1 : 0), expanded, groupState), width, pad);
		};
		return new ToolGroupComponent(rows, members, state, draw, () => tui.requestRender());
	}

	private resolvePaint(): Paint | undefined {
		const theme = this.context?.ui.theme;
		if (!theme) return undefined;
		const chrome = chromePainter(theme);
		const key = this.runtime.config.style + PAINT_COLORS.map((color) => theme.fg(color, "x")).join("") + theme.bold("x") + chrome("x");
		return { theme, chrome, key };
	}

	private drawCached(rows: readonly ToolRowLike[], width: number, expanded: boolean, state: GroupState): string[] {
		const paint = this.paint ?? this.resolvePaint();
		if (!paint) return [];
		const hostExpanded = isHostExpanded(rows);
		if (lastRunning(rows, this.canRun)) return this.draw(rows, width, expanded, paint, hostExpanded);
		const statuses = rows.map((row) => memberStatus(row, this.canRun));
		if (state.header && headerStill(state.header, rows, statuses, paint.key, width, expanded, hostExpanded)) {
			return state.header.lines;
		}
		const lines = this.draw(rows, width, expanded, paint, hostExpanded);
		state.header = {
			paint: paint.key,
			width,
			expanded,
			hostExpanded,
			rows: [...rows],
			args: rows.map((row) => row.args),
			results: rows.map((row) => row.result),
			statuses,
			lines,
		};
		return lines;
	}

	private draw(rows: readonly ToolRowLike[], width: number, expanded: boolean, paint: Paint, hostExpanded = isHostExpanded(rows)): string[] {
		if (expanded && hostExpanded) return [];
		const { theme, chrome } = paint;
		const fit = (line: string) => truncateToWidth(line, Math.max(1, width), "…");
		const running = lastRunning(rows, this.canRun);
		const statuses = rows.map((row) => memberStatus(row, this.canRun));
		const status: RowStatus = running ? "running" : statuses.includes("error") ? "error"
			: statuses.includes("pending") ? "pending" : "success";
		const summary = summarizeGroup(rows, (count) => theme.bold(count), this.canRun);
		let title = status === "success"
			? `   ${chrome(summary)}`
			: ` ${paintIndicator(theme, status, this.runtime.frame)} ${theme.fg("toolTitle", summary)}`;
		if (running) {
			this.runtime.keepAnimating(running.toolCallId);
			const started = this.runtime.timing(running.toolCallId)?.startedAt;
			const elapsed = started === undefined ? 0 : Date.now() - started;
			title += `${elapsed >= 2000 ? chrome(` · ${formatDurationMs(elapsed)}`) : ""}…`;
		}
		if (!expanded) title += chrome(` ${EXPAND_HINT}`);
		const lines = ["", fit(title)];
		const hintText = groupHint(rows, this.canRun);
		if (hintText) lines.push(fit(chrome(`${CLAUDE_RESULT_PREFIX}${hintText}`)));
		if (!expanded) for (const failure of groupFailures(rows)) lines.push(fit(chrome(CLAUDE_RESULT_PREFIX) + theme.fg("error", failure)));
		return lines;
	}
}
