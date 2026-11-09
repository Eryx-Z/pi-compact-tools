import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { normalizeLineEndings } from "./compact-tools-core.ts";
import {
	countEditChanges,
	formatResultLineSummary,
	summarizeCustomArguments,
	summarizeFailure,
} from "./compact-tools-invocation.ts";
import { isHarmlessRedirect, parseShell, writesOrRuns } from "./compact-tools-shell.ts";
import type { ToolArgs } from "./compact-tools-types.ts";

/**
 * Rows Claude Code shows of a command's output before "… +N lines". Output is
 * wrapped to the width first, so a long line counts as the rows it takes.
 */
export const CLAUDE_OUTPUT_ROWS = 3;
/** While Bash runs, Claude follows the last four output rows rather than the head. */
export const CLAUDE_RUNNING_OUTPUT_ROWS = 4;
/** Rows Claude Code shows of what a write put in the file. */
export const CLAUDE_WRITE_ROWS = 10;
/** Lines of context Claude Code keeps around each change in an edit's diff. */
export const CLAUDE_DIFF_CONTEXT_LINES = 3;

/**
 * Claude Code 2.1.312's chrome: `⏺ Bash(…)`, then `  ⎿  ` with the "⎿" under the
 * tool's name and the result two columns after it. Pi draws every row one column
 * in, with its own smaller "⦁" dot, so each prefix keeps that geometry one column
 * further right.
 */
export const CLAUDE_RESULT_PREFIX = "   ⎿  ";
/** Lines after the first under "⎿", and everything drawn beneath the result. */
export const CLAUDE_INDENT = "      ";
/** Where a wrapped call line continues: under the tool's name. */
export const CLAUDE_TITLE_INDENT = "   ";

/** Claude Code's names for the tools Pi shares with it. */
const LABELS: Readonly<Record<string, string>> = {
	read: "Read",
	grep: "Search",
	find: "Search",
	ls: "List",
	bash: "Bash",
	powershell: "PowerShell",
	edit: "Update",
	write: "Write",
};

export function claudeLabel(name: string): string {
	return LABELS[name] ?? name;
}

export function pathOf(args: ToolArgs): string {
	const value = args.path ?? args.file_path;
	return typeof value === "string" ? normalizeLineEndings(value) : "";
}

function oneLine(text: string): string {
	const lines = normalizeLineEndings(stripTerminalSequences(text)).split("\n").map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0) return "";
	return lines.length > 1 ? `${lines[0]} …` : lines[0]!;
}

function commandOf(args: ToolArgs): string {
	return typeof args.command === "string" ? args.command : "";
}

/** Claude Code shortens a collapsed command only past two lines or 160 characters. */
export const CLAUDE_COMMAND_LINES = 2;
export const CLAUDE_COMMAND_CHARS = 160;

/**
 * A command as Claude Code titles it: whole when opened, and collapsed cut only
 * past its line and character limits, with an ellipsis. Within them it is never
 * cut to fit the row; the title wraps instead.
 */
export function claudeCommand(command: string, expanded: boolean): string {
	const text = normalizeLineEndings(stripTerminalSequences(command)).trim();
	if (expanded) return text;
	const lines = text.split("\n");
	let shown = lines.length > CLAUDE_COMMAND_LINES ? lines.slice(0, CLAUDE_COMMAND_LINES).join("\n") : text;
	if (shown.length > CLAUDE_COMMAND_CHARS) shown = shown.slice(0, CLAUDE_COMMAND_CHARS);
	return shown === text ? text : `${shown.trim()}…`;
}

/** What goes between the parentheses: `Bash(npm test)`, `Search(pattern: "x", path: "src")`. */
export function claudeArgument(name: string, args: ToolArgs, expanded = false): string {
	const path = pathOf(args);
	if (name === "bash" || name === "powershell") return claudeCommand(commandOf(args), expanded);
	if (name === "grep" || name === "find") {
		const pattern = typeof args.pattern === "string" ? oneLine(args.pattern) : "";
		// Arguments stream in; until the pattern arrives there is nothing to name.
		if (!pattern) return "";
		return path ? `pattern: "${pattern}", path: "${path}"` : `pattern: "${pattern}"`;
	}
	if (name === "ls") return path || ".";
	if (name === "read" && expanded) {
		// Failed calls and streaming arguments can contain invalid ranges.
		const validLine = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
		if ((args.offset != null && !validLine(args.offset)) || (args.limit != null && !validLine(args.limit))) return path;
		const start = validLine(args.offset) ? args.offset : 1;
		if (validLine(args.limit)) return `${path} · lines ${start}-${start + args.limit - 1}`;
		if (validLine(args.offset)) return `${path} · from line ${start}`;
	}
	if (name === "read" || name === "edit" || name === "write") return path;
	return formatArguments(args);
}

function formatValue(value: unknown): string | undefined {
	if (typeof value === "string") return JSON.stringify(oneLine(value));
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value) && value.every((item) => typeof item !== "object" || item === null)) {
		return `[${value.map((item) => formatValue(item) ?? "null").join(", ")}]`;
	}
	return undefined;
}

/** A custom tool's arguments as Claude Code lists them: `query: "pi tui", limit: 5`. */
export function formatArguments(args: ToolArgs): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		const formatted = formatValue(value);
		if (formatted !== undefined) parts.push(`${key}: ${formatted}`);
	}
	return parts.length > 0 ? parts.join(", ") : summarizeCustomArguments(args);
}

export function claudeTitle(name: string, args: ToolArgs, expanded = false): { label: string; argument: string } {
	return { label: claudeLabel(name), argument: claudeArgument(name, args, expanded) };
}

// Claude Code's own lists: a command made only of these only looks around, so it
// folds into a group with reads and searches.
const SEARCH_COMMANDS = new Set(["find", "grep", "rg", "ag", "ack", "locate", "which", "whereis"]);
const READ_COMMANDS = new Set([
	"cat", "head", "tail", "less", "more", "wc", "stat", "file", "strings", "jq", "awk", "cut", "sort", "uniq", "tr",
]);
const LIST_COMMANDS = new Set(["ls", "tree", "du"]);
const NEUTRAL_COMMANDS = new Set(["echo", "printf", "true", "false", ":"]);

export type LookKind = "search" | "read" | "list";

/**
 * How a shell command looks around, if that is all it does: `rg x | head` searches,
 * `cat a.ts` reads, `ls src` lists. Anything that runs something else, writes a
 * file, or redirects anywhere but /dev/null is undefined, so a group never hides it.
 */
export function classifyShellCommand(command: string): LookKind | undefined {
	const parsed = parseShell(normalizeLineEndings(command));
	if (!parsed || parsed.opaque) return undefined;
	let search = false;
	let read = false;
	let list = false;
	for (const { words, redirects } of parsed.commands) {
		if (!redirects.every(isHarmlessRedirect) || writesOrRuns(words)) return undefined;
		const program = words[0];
		if (!program || NEUTRAL_COMMANDS.has(program)) continue;
		if (SEARCH_COMMANDS.has(program)) search = true;
		else if (READ_COMMANDS.has(program)) read = true;
		else if (LIST_COMMANDS.has(program)) list = true;
		else return undefined;
	}
	// Claude Code counts a call once: as a listing first, then a search, then a read.
	return list ? "list" : search ? "search" : read ? "read" : undefined;
}

/** Whether a call only looks around, and how; such calls fold into one group. */
export function lookKind(name: string, args: ToolArgs): LookKind | undefined {
	if (name === "read") return "read";
	if (name === "grep" || name === "find") return "search";
	if (name === "ls") return "list";
	if (name === "bash" || name === "powershell") return classifyShellCommand(commandOf(args));
	return undefined;
}

/** What a group's second line names while a call runs: a path, a pattern, a command. */
export function lookHint(name: string, args: ToolArgs): string {
	if (name === "grep" || name === "find") {
		const pattern = typeof args.pattern === "string" ? oneLine(args.pattern) : "";
		return pattern ? `"${pattern}"` : "";
	}
	if (name === "bash" || name === "powershell") {
		const command = oneLine(commandOf(args));
		return command ? `$ ${command}` : "";
	}
	return name === "ls" ? pathOf(args) || "." : pathOf(args);
}

function plural(count: number, singular: string): string {
	return count === 1 ? singular : `${singular}s`;
}

function countOf(summary: string | undefined): number {
	return Number.parseInt(summary ?? "0", 10) || 0;
}

/**
 * The result line for tools whose outcome is a sentence rather than output, worded
 * as Claude Code words it: "Read 42 lines", "Added 3 lines, removed 1 line". `bold`
 * marks the counts and paths Claude Code sets in bold. Tools whose output is the
 * result, commands and custom tools, return undefined and show it instead.
 */
export function claudeOutcome(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	output: string,
	bold: (text: string) => string = (text) => text,
): string | undefined {
	const lines = countOf(formatResultLineSummary(name, args, result, output));
	const count = (value: number, singular: string) => `${bold(String(value))} ${plural(value, singular)}`;
	switch (name) {
		case "read": return result.content.some((block) => block.type === "image") ? "Read image" : `Read ${count(lines, "line")}`;
		case "grep": return `Found ${count(lines, "line")}`;
		case "find": return `Found ${count(lines, "file")}`;
		case "ls": return `Listed ${count(lines, "path")}`;
		case "write": return `Wrote ${count(lines, "line")} to ${bold(pathOf(args))}`;
		case "edit": {
			const { added, removed } = countEditChanges(result) ?? { added: 0, removed: 0 };
			if (added > 0 && removed > 0) return `Added ${count(added, "line")}, removed ${count(removed, "line")}`;
			if (added > 0) return `Added ${count(added, "line")}`;
			if (removed > 0) return `Removed ${count(removed, "line")}`;
			return undefined;
		}
		default: return undefined;
	}
}

const SHELL_STATUS = /^Command (?:exited with code (\d+)|(timed out.*|aborted|terminated.*))$/iu;

/**
 * A failure as Claude Code reports it. A command leads with its exit code and
 * then shows what it printed; another tool leads with its reason alone.
 */
export function claudeFailure(name: string, output: string, expanded = false): { headline: string; detail: string } {
	if (name === "bash" || name === "powershell" || !TOOL_NAMES.has(name)) {
		const lines = normalizeLineEndings(output).trimEnd().split("\n");
		const status = lines.at(-1)?.trim().match(SHELL_STATUS);
		if (status) {
			const headline = status[1] !== undefined ? `Error: Exit code ${status[1]}` : `Error: ${status[2]}`;
			return { headline, detail: lines.slice(0, -1).join("\n").trimEnd() };
		}
		if (name === "bash" || name === "powershell") return { headline: "Error", detail: output.trimEnd() };
	}
	const reason = expanded
		? normalizeLineEndings(stripTerminalSequences(output)).trim()
		: summarizeFailure(name, output);
	return { headline: reason ? (/^Error\b/iu.test(reason) ? reason : `Error: ${reason}`) : "Error", detail: "" };
}

const TOOL_NAMES = new Set(Object.keys(LABELS));

const FD_DUP_REDIRECT = /^\d*(?:>&|<&)(?:\d+|-)/u;
const TARGET_REDIRECT = /^\d*(?:<<<|<<-?|&>>|&>|>>|>\|?|<>|<)/u;
const CONTROL_OPERATORS = ["&&", "||", "|&", "|", ";", "&", "("];
const SHELL_WRAPPERS = new Set(["sudo", "env", "nohup", "time", "nice", "xargs", "command", "builtin", "exec"]);

const PATH_TOKEN = /^(?:~\/|\/(?:etc|usr|var|home|opt|tmp|srv|run|lib|lib64|bin|sbin|proc|sys|dev|mnt|media|root|boot|snap|app|data|workspace|work)\b|\.\.?\/|\/(?:[\w.@+-]+\/)+)[\w./@+-]*$/u;

function highlightShellValue(value: string, theme: Theme): string {
	if (!value) return "";
	if (/^-?\d+(?:\.\d+)?$/u.test(value)) return theme.fg("syntaxNumber", value);
	if (PATH_TOKEN.test(value)) return theme.fg("mdCode", value);
	if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
		return theme.fg("syntaxString", value);
	}
	return theme.fg("toolOutput", value);
}

function highlightShellLine(line: string, theme: Theme): string {
	let output = "";
	let commandStart = true;
	let inAssignmentWord = false;
	let redirectState: "none" | "awaiting" | "consuming" = "none";
	let index = 0;
	while (index < line.length) {
		const rest = line.slice(index);
		const space = rest.match(/^[ \t]+/u)?.[0];
		if (space) {
			output += space;
			inAssignmentWord = false;
			if (redirectState === "consuming") redirectState = "none";
			index += space.length;
			continue;
		}
		if (rest[0] === "#") {
			output += highlightCommentLine(rest, theme);
			break;
		}
		if (rest === "…" || rest === "'…" || rest === "\"…") {
			output += theme.fg("syntaxPunctuation", rest);
			break;
		}
		const fdDup = rest.match(FD_DUP_REDIRECT)?.[0];
		if (fdDup) {
			output += theme.fg("syntaxOperator", fdDup);
			inAssignmentWord = false;
			redirectState = "none";
			index += fdDup.length;
			continue;
		}
		const targetRedirect = rest.match(TARGET_REDIRECT)?.[0];
		if (targetRedirect) {
			output += theme.fg("syntaxOperator", targetRedirect);
			inAssignmentWord = false;
			redirectState = "awaiting";
			index += targetRedirect.length;
			continue;
		}
		if (rest[0] === ")") {
			output += theme.fg("syntaxOperator", ")");
			inAssignmentWord = false;
			redirectState = "none";
			commandStart = false;
			index += 1;
			continue;
		}
		const operator = CONTROL_OPERATORS.find((candidate) => rest.startsWith(candidate));
		if (operator) {
			output += theme.fg("syntaxOperator", operator);
			inAssignmentWord = false;
			redirectState = "none";
			commandStart = true;
			index += operator.length;
			continue;
		}
		if (rest[0] === "'" || rest[0] === "\"") {
			const quote = rest[0]!;
			// Remote/subshell scripts (`ssh host '\n...`) open a quote at end of line;
			// keep inner lines highlighted as commands rather than one flat string.
			if (quote === "'" && /^'\s*$/u.test(rest)) {
				output += theme.fg("syntaxPunctuation", rest);
				break;
			}
			let end = 1;
			while (end < rest.length && rest[end] !== quote) {
				end += quote === "\"" && rest[end] === "\\" ? 2 : 1;
			}
			if (end < rest.length) {
				const literal = rest.slice(0, end + 1);
				output += theme.fg("syntaxString", literal);
				if (redirectState !== "none") redirectState = "consuming";
				else if (!inAssignmentWord) commandStart = false;
				index += literal.length;
				continue;
			}
			// Trailing quote before truncation ellipsis (`echo "=== ... ==="'…`)
			if (quote === "'" && index === 0) {
				output += theme.fg("syntaxPunctuation", "'");
				index += 1;
				continue;
			}
			const trailingEllipsis = rest.endsWith("…") ? "…" : "";
			const body = trailingEllipsis ? rest.slice(0, -1) : rest;
			output += theme.fg("syntaxString", body) + (trailingEllipsis ? theme.fg("syntaxPunctuation", trailingEllipsis) : "");
			break;
		}
		if (rest[0] === "$") {
			const variable = rest.match(/^\$(?:\{[^}]*\}?|[A-Za-z_][A-Za-z0-9_]*|[0-9#?@*$!-])?/u)![0];
			output += theme.fg("syntaxVariable", variable);
			if (redirectState !== "none") redirectState = "consuming";
			else if (!inAssignmentWord) commandStart = false;
			index += variable.length;
			continue;
		}
		const word = rest.match(/^[^\s'"$#&|;<>()]+/u)?.[0] ?? rest[0]!;
		const effectiveCommandStart = commandStart && !inAssignmentWord && redirectState === "none";
		const trailingQuoteEllipsis = word.match(/^(.+?)('?…|')$/u);
		if (trailingQuoteEllipsis && !word.startsWith("'")) {
			const [, head, tail] = trailingQuoteEllipsis;
			output += highlightShellToken(head!, effectiveCommandStart, theme) + theme.fg("syntaxPunctuation", tail!);
			if (redirectState !== "none") redirectState = "consuming";
			else if (!inAssignmentWord) commandStart = false;
			index += word.length;
			continue;
		}
		output += highlightShellToken(word, effectiveCommandStart, theme);
		if (redirectState !== "none") {
			redirectState = "consuming";
		} else if (effectiveCommandStart && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) {
			inAssignmentWord = true;
		} else if (!inAssignmentWord && !SHELL_WRAPPERS.has(word)) {
			commandStart = false;
		}
		index += word.length;
	}
	return output;
}

function highlightShellToken(word: string, commandStart: boolean, theme: Theme): string {
	const flagWithValue = word.match(/^(--?[A-Za-z0-9][\w-]*)(=)(.*)$/u);
	if (flagWithValue) {
		const [, flag, eq, val] = flagWithValue;
		return theme.fg("syntaxKeyword", flag!) + theme.fg("syntaxOperator", eq!) + highlightShellValue(val!, theme);
	}
	const keyValue = word.match(/^([A-Za-z_][\w.-]*)(=)(.*)$/u);
	if (keyValue) {
		const [, key, eq, val] = keyValue;
		return theme.fg("syntaxType", key!) + theme.fg("syntaxOperator", eq!) + highlightShellValue(val!, theme);
	}
	if (commandStart) return theme.fg("syntaxFunction", word);
	if (word.startsWith("-")) return theme.fg("syntaxKeyword", word);
	return highlightShellValue(word, theme);
}

/** Highlight a multi-line shell command for `Bash(...)` / `PowerShell(...)` call titles. */
export function highlightClaudeShellCommand(command: string, theme: Theme): string {
	return normalizeLineEndings(command)
		.split("\n")
		.map((line) => highlightShellLine(line, theme))
		.join("\n");
}

const BANNER_ARROW_LINE = /^(\s*)(==>)(\s*\S.*?\s*)(<==)(\s*)$/u;
const BANNER_EQ_LINE = /^(\s*)(={2,})(\s*\S.*?\s*)(={2,})(\s*)$/u;
const BANNER_DASH_LINE = /^(\s*)(-{3,})(\s*\S.*?\s*)(-{3,})(\s*)$/u;
const BANNER_STAR_LINE = /^(\s*)(\*{3,})(\s*\S.*?\s*)(\*{3,})(\s*)$/u;
const BANNER_DIAGNOSTIC = /\b(?:error|fatal|panic|critical|failed|fail)\b/iu;
const SECTION_HEADER_LINE = /^(\s*\[)([A-Za-z0-9_.: -]+)(\]\s*)$/u;
const KEY_VALUE_LINE = /^(\s*)([A-Za-z_][\w.-]*)(\s*=(?!=)\s*)(.*)$/u;
const STATUS_FIELD_LINE = /^(\s*)(Loaded|Active|Status|Main PID|Tasks|Memory|CPU|CGroup|Docs|Process|Drop-In)(:)(\s+.*)$/u;
const COMMENT_LINE = /^(\s*#)(.*)$/u;

function matchBannerLine(line: string): RegExpMatchArray | null {
	const match = line.match(BANNER_ARROW_LINE)
		?? line.match(BANNER_EQ_LINE)
		?? line.match(BANNER_DASH_LINE)
		?? line.match(BANNER_STAR_LINE);
	if (!match) return null;
	const open = match[2]!;
	const title = match[3]!;
	if (!/[^\s=*-]/u.test(title)) return null;
	if (open !== "==>" && BANNER_DIAGNOSTIC.test(title)) return null;
	return match;
}

const INLINE_OUTPUT_TOKEN = new RegExp(
	[
		// 1. Multi-word status phrases
		"(?<successPhrase>\\bactive\\s+\\((?:running|exited|waiting|listening)\\))",
		"(?<errorPhrase>\\binactive\\s+\\(dead\\)|\\bfailed\\s+\\([^)\\n]+\\)|\\b(?:connection refused|permission denied|no such file or directory|command exited with code \\d+)\\b)",
		// 2. Unix / tilde file paths (avoid splitting URLs after `://`)
		"(?<path>(?<![\\w./-])(?:~\\/[\\w./@+-]+|\\/(?:etc|usr|var|home|opt|tmp|srv|run|lib|lib64|bin|sbin|proc|sys|dev|mnt|media|root|boot|snap|app|data|workspace|work)(?:\\/[\\w.@+-]*)+|\\/(?:[\\w.@+-]+\\/)+[\\w.@+-]+))",
		// 3. Quoted literals (avoid matching English contractions like `can't ... don't`)
		"(?<string>\"[^\"\\n]*\"|(?<![\\p{L}\\p{N}_])'[^'\\n]*'(?![\\p{L}\\p{N}_]))",
		// 4. Error / Warning / Success keywords
		"(?<errorWord>\\b(?:ERROR|FATAL|PANIC|CRITICAL|FAILED|FAIL|ERR|DEAD|OFFLINE|UNHEALTHY|KILLED|OOM|inactive|failed)\\b)",
		"(?<warningWord>\\b(?:WARNING|WARN|DEPRECATED|TIMEOUT|RETRY|DEGRADED|activating|deactivating|reloading|disabled|masked)\\b)",
		"(?<successWord>\\b(?:SUCCESS|SUCCEEDED|PASSED|PASS|OK|ONLINE|HEALTHY|(?:active|enabled|loaded|running|listening)(?![ \\t]*:))\\b)",
	].join("|"),
	"giu",
);

function highlightInlineOutput(text: string, theme: Theme, baseColor: Parameters<Theme["fg"]>[0] = "toolOutput"): string {
	if (!text) return "";
	const plain = (segment: string) => (segment ? theme.fg(baseColor, segment) : "");
	let output = "";
	let lastIndex = 0;
	for (const match of text.matchAll(INLINE_OUTPUT_TOKEN)) {
		const index = match.index ?? 0;
		output += plain(text.slice(lastIndex, index));
		const whole = match[0]!;
		const groups = match.groups ?? {};
		if (groups.successPhrase !== undefined || groups.successWord !== undefined) {
			output += theme.fg("success", whole);
		} else if (groups.errorPhrase !== undefined || groups.errorWord !== undefined) {
			output += theme.fg("error", whole);
		} else if (groups.warningWord !== undefined) {
			output += theme.fg("warning", whole);
		} else if (groups.path !== undefined) {
			output += theme.fg("mdCode", whole);
		} else if (groups.string !== undefined) {
			output += theme.fg("syntaxString", whole);
		} else {
			output += plain(whole);
		}
		lastIndex = index + whole.length;
	}
	return output + plain(text.slice(lastIndex));
}

function highlightCommentLine(line: string, theme: Theme): string {
	return highlightInlineOutput(line, theme, "syntaxComment");
}

/**
 * Highlight a single line of shell/tool output using theme semantic and syntax tokens:
 * - Banners (`=== ... ===`) -> `accent` markers + bold `mdHeading` title
 * - Comments (`# /etc/...`) -> `syntaxComment` text + `mdCode` paths
 * - INI/systemd headers (`[Unit]`, `[Service]`) -> bold `syntaxKeyword`
 * - `Key=Value` config lines -> `syntaxType` key + highlighted value
 * - Status keywords & paths -> `success` / `warning` / `error` / `mdCode`
 */
export function highlightClaudeOutputLine(line: string, theme: Theme): string {
	if (!line || /\x1b/u.test(line)) return line;
	const banner = matchBannerLine(line);
	if (banner) {
		const [, lead = "", open = "", title = "", close = "", tail = ""] = banner;
		return lead
			+ theme.fg("accent", open)
			+ theme.bold(theme.fg("mdHeading", title))
			+ (close ? theme.fg("accent", close) : "")
			+ tail;
	}
	if (COMMENT_LINE.test(line)) {
		return highlightCommentLine(line, theme);
	}
	const section = line.match(SECTION_HEADER_LINE);
	if (section) {
		const [, open = "[", name = "", close = "]"] = section;
		return theme.fg("syntaxPunctuation", open)
			+ theme.bold(theme.fg("syntaxKeyword", name))
			+ theme.fg("syntaxPunctuation", close);
	}
	const kv = line.match(KEY_VALUE_LINE);
	if (kv) {
		const [, indent = "", key = "", eq = "=", val = ""] = kv;
		return indent
			+ theme.fg("syntaxType", key)
			+ theme.fg("syntaxOperator", eq)
			+ highlightInlineOutput(val, theme, "toolOutput");
	}
	const statusField = line.match(STATUS_FIELD_LINE);
	if (statusField) {
		const [, indent = "", label = "", colon = ":", rest = ""] = statusField;
		return indent
			+ theme.fg("syntaxType", label)
			+ theme.fg("syntaxPunctuation", colon)
			+ highlightInlineOutput(rest, theme, "toolOutput");
	}
	return highlightInlineOutput(line, theme, "toolOutput");
}

