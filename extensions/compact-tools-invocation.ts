import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { normalizeLineEndings } from "./compact-tools-core.ts";
import type { ToolArgs } from "./compact-tools-types.ts";

/** Historical/transcribed read arguments may contain numeric strings or null. Display only. */
export function readStartLine(value: unknown): number {
	if (typeof value === "string" && value.trim() !== "") value = Number(value);
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

const CUSTOM_SUMMARY_KEYS = [
	"command", "query", "queries", "q", "url", "urls", "path", "file_path", "paths",
	"pattern", "prompt", "question", "claim", "name", "id", "tool",
];
const CUSTOM_SUMMARY_MAX_LENGTH = 160;

function summaryObject(record: Readonly<Record<string, unknown>>): string | undefined {
	for (const key of CUSTOM_SUMMARY_KEYS) {
		if (!(key in record)) continue;
		const nested = summaryValue(record[key], false);
		if (nested?.trim()) return nested;
	}
	return undefined;
}

function summaryValue(value: unknown, allowNested = true): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		const parts: string[] = [];
		for (const item of value) {
			if (typeof item === "string" || typeof item === "number") {
				if (String(item).trim()) parts.push(String(item));
			} else if (allowNested && item !== null && typeof item === "object" && !Array.isArray(item)) {
				const nested = summaryObject(item as Readonly<Record<string, unknown>>);
				if (nested?.trim()) parts.push(nested);
			}
		}
		return parts.length > 0 ? parts.join(", ") : undefined;
	}
	if (allowNested && value !== null && typeof value === "object") {
		return summaryObject(value as Readonly<Record<string, unknown>>);
	}
	return undefined;
}

/** One line describing a custom tool call; the full arguments stay available when expanded. */
export function summarizeCustomArguments(args: ToolArgs): string {
	const keys = new Set([...CUSTOM_SUMMARY_KEYS.filter((key) => key in args), ...Object.keys(args)]);
	for (const key of keys) {
		const value = summaryValue(args[key]);
		if (!value?.trim()) continue;
		const line = stripTerminalSequences(normalizeLineEndings(value))
			.replace(/[\x00-\x1f\x7f]/gu, " ")
			.replace(/\s+/gu, " ")
			.trim();
		return line.length > CUSTOM_SUMMARY_MAX_LENGTH
			? `${line.slice(0, CUSTOM_SUMMARY_MAX_LENGTH - 1).trimEnd()}…`
			: line;
	}
	return "";
}

export function getTextResult(result: AgentToolResult<unknown>): string {
	const parts: string[] = [];
	for (const item of result.content) {
		if (item.type === "text") parts.push(item.text);
	}
	return normalizeLineEndings(parts.join("\n")).trimEnd();
}

const FAILURE_REASON_MAX_LENGTH = 140;

/** Pull a useful diagnostic into a collapsed failed row without exposing raw control sequences. */
export function summarizeFailure(name: string, output: string): string | undefined {
	const lines = normalizeLineEndings(stripTerminalSequences(output))
		.split("\n")
		.map((line) => line.replace(/[\x00-\x1f\x7f]/gu, " ").trim())
		.filter(Boolean);
	if (lines.length === 0) return undefined;
	const last = lines[lines.length - 1]!;
	const shellStatus = (name === "bash" || name === "powershell")
		&& /^Command (?:exited with code \d+|timed out.*|aborted|terminated.*)$/iu.test(last)
		? last
		: undefined;
	const diagnostic = shellStatus
		? lines.slice(0, -1).reverse().find((line) =>
			/\b(?:error|failed|failure|fatal|exception|denied|not found|no such file)\b|ENOENT/iu.test(line))
		: undefined;
	const reason = diagnostic ? `${diagnostic} (${shellStatus})` : shellStatus ?? lines[0]!;
	return reason.length > FAILURE_REASON_MAX_LENGTH
		? `${reason.slice(0, FAILURE_REASON_MAX_LENGTH - 1).trimEnd()}…`
		: reason;
}

type ResultDetails = {
	diff?: unknown;
	patch?: unknown;
	truncation?: {
		firstLineExceedsLimit?: boolean;
		outputLines?: number;
	};
	matchLimitReached?: unknown;
	resultLimitReached?: unknown;
	entryLimitReached?: unknown;
	linesTruncated?: unknown;
};

function countTextLines(text: string): number {
	const normalized = normalizeLineEndings(text).trimEnd();
	if (!normalized) return 0;
	let count = 1;
	for (let index = 0; index < normalized.length; index++) {
		if (normalized.charCodeAt(index) === 10) count++;
	}
	return count;
}

export function getEditDiff(result: AgentToolResult<unknown>): string {
	const diff = (result.details as ResultDetails | undefined)?.diff;
	return typeof diff === "string" ? normalizeLineEndings(diff).trimEnd() : "";
}

export function getEditPatch(result: AgentToolResult<unknown>): string {
	const patch = (result.details as ResultDetails | undefined)?.patch;
	return typeof patch === "string" ? normalizeLineEndings(patch).trimEnd() : "";
}

function isDiffHeaderLine(line: string): boolean {
	return line.startsWith("+++ ") || line.startsWith("--- ");
}

export function getEditChanges(result: AgentToolResult<unknown>): string {
	return getEditDiff(result)
		.split("\n")
		.filter((line) => (line.startsWith("-") || line.startsWith("+")) && !isDiffHeaderLine(line))
		.join("\n")
		.trimEnd();
}

export function countEditChanges(result: AgentToolResult<unknown>): { added: number; removed: number } | undefined {
	const diff = getEditDiff(result);
	if (!diff) return undefined;
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (isDiffHeaderLine(line)) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

const READ_FOOTER = /\n\n(\[(?:Showing lines |\d+ more lines in file\.)[^\n]*\])$/u;

export function splitReadFooter(text: string): { body: string; footer?: string } {
	const match = text.match(READ_FOOTER);
	return match ? { body: text.slice(0, match.index), footer: match[1] } : { body: text };
}

export function isReadTextResult(result: AgentToolResult<unknown>): boolean {
	const details = result.details as ResultDetails | undefined;
	return !details?.truncation?.firstLineExceedsLimit
		&& !result.content.some((item) => item.type === "image");
}

function stripGeneratedFooter(name: string, text: string, details: ResultDetails | undefined): string {
	if (name === "read") return splitReadFooter(text).body;
	const hasGeneratedFooter = details?.truncation?.outputLines !== undefined
		|| details?.matchLimitReached !== undefined
		|| details?.resultLimitReached !== undefined
		|| details?.entryLimitReached !== undefined
		|| details?.linesTruncated !== undefined;
	return hasGeneratedFooter ? text.replace(/\n\n\[[^\n]*\]$/u, "") : text;
}

export function formatResultLineSummary(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	output?: string,
): string | undefined {
	const details = result.details as ResultDetails | undefined;
	const text = name === "edit"
		? getEditChanges(result)
		: output ?? (name === "write"
			? String(args.content ?? "")
			: result.content.some((item) => item.type === "text")
				? getTextResult(result)
				: undefined);
	if (text === undefined) return undefined;
	const truncationLines = details?.truncation?.outputLines;
	const lineCount = !details?.truncation?.firstLineExceedsLimit
		&& typeof truncationLines === "number"
		&& Number.isInteger(truncationLines)
		&& truncationLines >= 0
		? truncationLines
		: countTextLines(stripGeneratedFooter(name, text, details));
	return `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
}

export function getFileOutput(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	isError: boolean,
): string {
	if (isError || name === "read" || name === "grep" || name === "find" || name === "ls") {
		return getTextResult(result);
	}
	return name === "write" ? String(args.content ?? "") : "";
}
