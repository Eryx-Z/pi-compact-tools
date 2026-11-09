import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const SUPPORTED_TOOLS = ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"] as const;
export const SUPPORTED_TOOL_SET = new Set<string>(SUPPORTED_TOOLS);

export type CompactToolName = (typeof SUPPORTED_TOOLS)[number];
export type ShellToolName = "bash" | "powershell";
export type ToolArgs = Record<string, unknown>;
export type BuiltInDefinition = ToolDefinition<any, any, any>;

export const DISPLAY_MODES = ["normal", "silent"] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];
/** How tool rows are drawn: Claude Code style or Pi's native renderer. */
export const DISPLAY_STYLES = ["claude", "off"] as const;
export type DisplayStyle = (typeof DISPLAY_STYLES)[number];

export interface CustomToolsConfig {
	/** Render tools registered by other extensions in Claude style as well. */
	enabled: boolean;
	exclude: string[];
}

export interface CompactToolsConfig {
	mode: DisplayMode;
	style: DisplayStyle;
	tools: CompactToolName[];
	custom_tools: CustomToolsConfig;
}

export interface RowState {
	expanded?: boolean;
	hasResult?: boolean;
	lastHostExpanded?: boolean;
	configRevision?: object;
	/** The row has its final result, whether or not it was timed. */
	finished?: boolean;
	startedAt?: number;
	endedAt?: number;
	/** Host-recorded final duration, when available (Pi 1.1+). */
	durationMs?: number;
	resultLineSummary?: string;
	resultLineSummaryComputed?: boolean;
	lastResultContent?: unknown;
	lastResultDetails?: unknown;
	lastResultPartial?: boolean;
	lastResultExpanded?: boolean;
	lastResultError?: boolean;
	lastResultConfigRevision?: object;
	lastResultPalette?: object;
	lastResultDurationMs?: number;
	lastResultOutputPad?: number;
	lastResultExpandKey?: string;
}

type BaseRenderContext = Parameters<NonNullable<BuiltInDefinition["renderCall"]>>[2];
export type RenderContext<TArgs = ToolArgs> = Omit<BaseRenderContext, "args" | "state" | "durationMs" | "outputPad" | "keyText" | "keyHint"> & {
	args: TArgs;
	state: RowState;
	/** Optional across hosts: older Pi versions do not provide these fields. */
	durationMs?: number;
	outputPad?: number;
	/** Pi 1.5+ injects the host's configured keys; legacy hosts omit them. */
	keyText?: (keybinding: "app.tools.expand") => string;
	keyHint?: (keybinding: "app.tools.expand", description: string) => string;
};

/** An unbound action stays unbound; only legacy hosts need the default fallback. */
export function toolExpandKey(ctx: Pick<RenderContext, "keyText">): string {
	return ctx.keyText?.("app.tools.expand") ?? "ctrl+o";
}
