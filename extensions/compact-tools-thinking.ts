import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	isKeyRelease,
	isKeyRepeat,
	Key,
	matchesKey,
	stripTerminalSequences,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { chromePainter } from "./compact-tools-palette.ts";

export type ThinkingView = "summary" | "detail" | "hidden";
export type ThinkingPhase = "summary" | "detail" | "summary-after-detail" | "hidden";

type ThinkingRenderOptions = {
	styleSummary?: (summary: string, sectionIndex: number) => string;
	styleDetailPrefix?: (prefix: string) => string;
	controls?: string | ((hasDetail: boolean) => string | undefined);
	styleControlPrefix?: (prefix: string) => string;
};

const NEXT_PHASE: Record<ThinkingPhase, ThinkingPhase> = {
	summary: "detail",
	detail: "summary-after-detail",
	"summary-after-detail": "hidden",
	hidden: "summary",
};

export function thinkingViewForPhase(phase: ThinkingPhase): ThinkingView {
	return phase === "summary-after-detail" ? "summary" : phase;
}

export function nextThinkingPhase(phase: ThinkingPhase): ThinkingPhase {
	return NEXT_PHASE[phase];
}

export type ThinkingToggleInput = "toggle" | "repeat" | "release";

export function classifyThinkingToggleInput(data: string): ThinkingToggleInput | undefined {
	if (!matchesKey(data, Key.ctrl("t"))) return undefined;
	if (isKeyRelease(data)) return "release";
	return isKeyRepeat(data) ? "repeat" : "toggle";
}

function plainSummary(line: string): string {
	const codeSpans: string[] = [];
	return line
		.replace(/^\s{0,3}#{1,6}\s+/u, "")
		.replace(/^\s*[-*+]\s+/u, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
		.replace(/`([^`]+)`/gu, (_match, code: string) => {
			codeSpans.push(code);
			return `\0${codeSpans.length - 1}\0`;
		})
		.replace(/[*~`]/gu, "")
		.replace(/(?<![\w])_+([^_\s](?:.*?[^_\s])?)_+(?![\w]|\.\w)/gu, "$1")
		.replace(/\0(\d+)\0/gu, (_match, index: string) => codeSpans[Number(index)] ?? "")
		.replace(/\s+/gu, " ")
		.trim();
}

type ThinkingSection = { summary: string; detail: string };

function parseFence(line: string): string | undefined {
	const match = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/u);
	if (!match) return undefined;
	const marker = match[1]!;
	const rest = match[2] ?? "";
	if (marker[0] === "`" && rest.includes("`")) return undefined;
	return marker;
}

function isClosingFence(line: string, openMarker: string): boolean {
	const match = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/u);
	if (!match) return false;
	const marker = match[1]!;
	return marker[0] === openMarker[0] && marker.length >= openMarker.length;
}

function splitThinkingSections(markdown: string): ThinkingSection[] {
	const normalized = markdown.includes("\r") ? markdown.replace(/\r\n?/gu, "\n") : markdown;
	const lines = normalized.split("\n");
	let first = -1;
	let summary = "";
	let startFromFirst = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (!line.trim()) continue;
		if (parseFence(line)) {
			first = index;
			summary = "Thinking...";
			startFromFirst = true;
			break;
		}
		summary = plainSummary(line);
		if (summary) {
			first = index;
			break;
		}
	}
	if (first < 0) return [{ summary: "Thinking...", detail: "" }];
	const sections: ThinkingSection[] = [];
	let detail: string[] = [];
	let openFence: string | undefined;
	const flush = () => {
		sections.push({ summary, detail: detail.join("\n").trim() });
		detail = [];
	};
	for (let index = startFromFirst ? first : first + 1; index < lines.length; index++) {
		const line = lines[index]!;
		if (openFence === undefined) {
			const fence = parseFence(line);
			if (fence) {
				openFence = fence;
				detail.push(line);
				continue;
			}
			const boldHeading = line.match(/^\s*\*\*(.+?)\*\*\s*$/u)?.[1];
			const markdownHeading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/u)?.[1];
			const heading = boldHeading ?? markdownHeading;
			if (heading) {
				const nextSummary = plainSummary(heading);
				if (nextSummary) {
					flush();
					summary = nextSummary;
					continue;
				}
			}
			detail.push(line);
		} else {
			detail.push(line);
			if (isClosingFence(line, openFence)) {
				openFence = undefined;
			}
		}
	}
	flush();
	return sections;
}

function compactDetail(
	detail: string,
	availableWidth: number,
	stylePrefix: (prefix: string) => string,
): string {
	const output: string[] = [];
	let openFence: string | undefined;
	for (const logicalLine of detail.replace(/\t/gu, "   ").split("\n")) {
		if (openFence === undefined) {
			const fence = parseFence(logicalLine);
			if (fence) {
				// Fences need a real blockquote and blank delimiter to remain valid Markdown.
				output.push("", `> ${logicalLine}`);
				openFence = fence;
				continue;
			}
		} else {
			output.push(logicalLine ? `> ${logicalLine}` : ">");
			if (isClosingFence(logicalLine, openFence)) {
				openFence = undefined;
				output.push("");
			}
			continue;
		}
		if (!logicalLine) {
			output.push(`${stylePrefix("│")}  `);
			continue;
		}
		const wrapped = wrapTextWithAnsi(logicalLine, Math.max(1, availableWidth - 2));
		for (const line of wrapped) {
			output.push(`${stylePrefix("│ ")}${stripTerminalSequences(line)}  `);
		}
	}
	return output.join("\n");
}

function hardBreak(lines: string[]): string {
	return lines.map((line, index) => (index < lines.length - 1 ? `${line}  ` : line)).join("\n");
}

function sectionsHaveDetail(sections: readonly ThinkingSection[]): boolean {
	return sections.some(({ detail }) => detail.length > 0);
}

export function hasThinkingDetail(markdown: string): boolean {
	return sectionsHaveDetail(splitThinkingSections(markdown));
}

function renderThinkingSections(
	sections: readonly ThinkingSection[],
	view: ThinkingView,
	availableWidth: number,
	options: ThinkingRenderOptions = {},
): string {
	if (view === "hidden") return "Thinking...";
	const controls = options.controls ?? ((hasDetail: boolean) =>
		hasDetail ? "ctrl+t toggle • click to hide" : undefined);
	const styleControlPrefix = options.styleControlPrefix ?? ((prefix: string) => prefix);
	return sections
		.map(({ summary, detail }, sectionIndex) => {
			// The summary is never cut short: a provider that sends one unstructured
			// paragraph has no detail to expand into, so the summary is all there is.
			// The host's Markdown component wraps it to the available width.
			const plain = stripTerminalSequences(summary);
			const title = options.styleSummary?.(plain, sectionIndex) ?? plain;
			const sectionControls = view === "detail"
				? typeof controls === "function" ? controls(detail.length > 0) : controls
				: undefined;
			const controlLines = sectionControls
				? wrapTextWithAnsi(sectionControls, Math.max(1, availableWidth - 2)).map(
						(line, index) => `${index === 0 ? styleControlPrefix("└ ") : "  "}${line}`,
					)
				: [];
			if (view === "detail" && detail) {
				const styleDetailPrefix = options.styleDetailPrefix ?? ((prefix: string) => prefix);
				const connector = `${styleDetailPrefix("│")}  `;
				const detailOutput = `${title}  \n${connector}\n${compactDetail(detail, availableWidth, styleDetailPrefix)}`;
				return controlLines.length > 0 ? `${detailOutput}\n${hardBreak(controlLines)}` : detailOutput;
			}
			return hardBreak([title, ...controlLines]);
		})
		.join("\n\n");
}

/** Display-only transformation; the original thinking remains unchanged in session/model context. */
export function renderThinkingView(
	markdown: string,
	view: ThinkingView,
	availableWidth: number,
	options: ThinkingRenderOptions = {},
): string {
	return renderThinkingSections(splitThinkingSections(markdown), view, availableWidth, options);
}

function getInitialThinkingPhase(): ThinkingPhase {
	try {
		const settings = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as {
			hideThinkingBlock?: unknown;
		};
		return settings.hideThinkingBlock === true ? "hidden" : "summary";
	} catch {
		return "summary";
	}
}

export class ThinkingCycleController {
	private context: ExtensionContext | undefined;
	private phase: ThinkingPhase = "summary";
	private unsubscribe: (() => void) | undefined;
	private theme: Theme | undefined;
	private hasToggleableThinking = false;
	private refreshThinking: (() => void) | undefined;

	constructor(pi: ExtensionAPI, enabled: () => boolean = () => true) {
		pi.registerMarkdownTransformer((markdown, context) => {
			// Off also applies before session_start, during transcript reconstruction
			// and HTML exports. Do not summarize or restyle native thinking there.
			if (!enabled() || context.messageType !== "assistant-thinking") return markdown;
			const sections = splitThinkingSections(markdown);
			this.hasToggleableThinking ||= sectionsHaveDetail(sections);
			const theme = this.theme;
			const detailTextPrefix = theme?.getFgAnsi("thinkingText");
			// Derived once per transform: the rail is drawn for every wrapped line of detail.
			const rail = theme ? chromePainter(theme) : undefined;
			return renderThinkingSections(sections, thinkingViewForPhase(this.phase), context.availableWidth, {
				// Keep thinking chrome neutral across themes: effort-level and border colors can
				// be intentionally vivid and are not content hierarchy colors.
				styleSummary: theme ? (summary) => theme.fg("text", theme.bold(summary)) : undefined,
				// Prefix styling resets the foreground; resume the host's thinking text color.
				// The rail and connector are the same frame the tool rows draw, so they take
				// the same chrome tone rather than a color name of their own.
				styleDetailPrefix: rail && detailTextPrefix
					? (prefix) => rail(prefix) + detailTextPrefix
					: undefined,
				controls: theme
					? (hasDetail) => hasDetail
						? theme.fg(
								"dim",
								`${theme.italic("ctrl+t")} toggle • ${theme.italic("click")} to hide`,
							)
						: undefined
					: undefined,
				styleControlPrefix: rail,
			});
		});
	}

	bind(ctx: ExtensionContext): void {
		this.unsubscribe?.();
		this.context = ctx;
		this.theme = ctx.ui.theme;
		this.hasToggleableThinking = false;
		// Match Pi's persisted host visibility after startup or /reload. When the
		// host is hidden, Markdown transformers are not invoked at all. Pi wraps
		// this label in thinkingText, so an inner text span keeps it consistent with
		// completed summary titles.
		this.phase = getInitialThinkingPhase();
		const hiddenLabel = this.theme.fg("text", this.theme.bold("Thinking..."));
		// Pi does not currently expose transcript invalidation directly. Updating
		// this label rebuilds assistant Markdown and requests a render without
		// changing the message or its hidden/visible state.
		this.refreshThinking = () => ctx.ui.setHiddenThinkingLabel(hiddenLabel);
		this.refreshThinking();
		this.unsubscribe = ctx.ui.onTerminalInput((data) => {
			const input = classifyThinkingToggleInput(data);
			if (input === undefined) return undefined;
			// Kitty-capable macOS terminals report held keys as repeat events. Treating
			// those as presses can skip detail before the user sees it.
			if (input === "release" || input === "repeat") return { consume: true };
			if (this.phase === "hidden") {
				this.phase = "summary";
				return undefined;
			}
			// With no provider-supplied detail, leave Ctrl+T to Pi's normal
			// visible/hidden toggle instead of inserting an identical detail phase.
			if (!this.hasToggleableThinking) return undefined;
			this.phase = nextThinkingPhase(this.phase);
			if (this.phase === "detail" || this.phase === "summary-after-detail") {
				// Visible-to-visible transitions are owned by this extension. Rebuild the
				// Markdown and prevent Pi's built-in two-state toggle from hiding it.
				this.refreshThinking?.();
				return { consume: true };
			}
			// summary-after-detail -> hidden and hidden -> summary intentionally reach
			// Pi's existing two-state handler. This keeps visibility/settings in sync
			// and clears built-in per-block click overrides.
			return undefined;
		});
	}

	dispose(restoreNative = false): void {
		const context = this.context;
		const unsubscribe = this.unsubscribe;
		this.context = undefined;
		this.unsubscribe = undefined;
		this.refreshThinking = undefined;
		this.hasToggleableThinking = false;
		this.theme = undefined;
		try { unsubscribe?.(); }
		finally { if (restoreNative) context?.ui.setHiddenThinkingLabel(); }
	}
}
