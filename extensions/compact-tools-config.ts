import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DISPLAY_MODES,
	DISPLAY_STYLES,
	SUPPORTED_TOOL_SET,
	type CompactToolName,
	type CompactToolsConfig,
	type DisplayMode,
	type DisplayStyle,
} from "./compact-tools-types.ts";

const CONFIG_FILE = "compact-tools.json";
const ROOT_KEYS = new Set(["$schema", "style", "mode", "tools", "custom_tools"]);
const CUSTOM_TOOLS_KEYS = new Set(["enabled", "exclude"]);
const warnedMessages = new Set<string>();
type JsonObject = Record<string, unknown>;

export const DEFAULT_CONFIG: CompactToolsConfig = {
	mode: "normal",
	style: "claude",
	tools: ["read", "write", "edit", "bash"],
	custom_tools: {
		enabled: true,
		exclude: [],
	},
};

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warn(path: string, message: string): void {
	const formatted = `[compact-tools] ${path}: ${message}`;
	if (warnedMessages.has(formatted)) return;
	warnedMessages.add(formatted);
	console.error(formatted);
}

function parseChoice<T extends string>(value: unknown, choices: readonly T[], key: string, path?: string): T | undefined {
	if ((choices as readonly unknown[]).includes(value)) return value as T;
	if (path !== undefined) warn(path, `${key} must be one of ${choices.join(", ")}; using previous value`);
	return undefined;
}

export function parseStyle(value: unknown, path?: string): DisplayStyle | undefined {
	if (value === "compact" || value === "codex") return "claude";
	return parseChoice<DisplayStyle>(value, DISPLAY_STYLES, "style", path);
}

function parseTools(value: unknown, path: string): CompactToolName[] | undefined {
	if (!Array.isArray(value)) {
		warn(path, "tools must be an array; using previous values");
		return undefined;
	}
	const tools: CompactToolName[] = [];
	const invalid: unknown[] = [];
	for (const item of value) {
		if (typeof item === "string" && SUPPORTED_TOOL_SET.has(item)) tools.push(item as CompactToolName);
		else invalid.push(item);
	}
	if (invalid.length > 0) warn(path, `ignoring unsupported tools: ${invalid.map(String).join(", ")}`);
	return [...new Set(tools)];
}

function parseCustomTools(
	base: CompactToolsConfig["custom_tools"],
	value: unknown,
	path: string,
): CompactToolsConfig["custom_tools"] {
	if (value === undefined) return base;
	if (typeof value === "boolean") return { ...base, enabled: value };
	if (!isObject(value)) {
		warn(path, "custom_tools must be true, false, or an object; using previous values");
		return base;
	}
	const unknown = Object.keys(value).filter((key) => !CUSTOM_TOOLS_KEYS.has(key));
	if (unknown.length > 0) warn(path, `ignoring unknown custom_tools keys: ${unknown.join(", ")}`);
	const result = { ...base };
	if (value.enabled !== undefined) {
		if (typeof value.enabled === "boolean") result.enabled = value.enabled;
		else warn(path, "custom_tools.enabled must be true or false; using previous value");
	}
	if (value.exclude !== undefined) {
		if (Array.isArray(value.exclude) && value.exclude.every((name) => typeof name === "string")) {
			result.exclude = [...new Set(value.exclude as string[])];
		} else {
			warn(path, "custom_tools.exclude must be an array of tool names; using previous values");
		}
	}
	return result;
}

export function mergeConfig(base: CompactToolsConfig, value: unknown, path: string): CompactToolsConfig {
	if (value === undefined) return base;
	if (!isObject(value)) {
		warn(path, "expected a JSON object; using previous values");
		return base;
	}
	const unknown = Object.keys(value).filter((key) => !ROOT_KEYS.has(key));
	if (unknown.length > 0) warn(path, `ignoring unknown keys: ${unknown.join(", ")}`);
	const mode = value.mode === undefined ? base.mode : (parseChoice<DisplayMode>(value.mode, DISPLAY_MODES, "mode", path) ?? base.mode);
	const style = value.style === undefined ? base.style : (parseStyle(value.style, path) ?? base.style);
	const tools = value.tools === undefined ? base.tools : (parseTools(value.tools, path) ?? base.tools);
	const custom_tools = parseCustomTools(base.custom_tools, value.custom_tools, path);
	return { mode, style, tools, custom_tools };
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		warn(path, error instanceof Error ? error.message : String(error));
		return undefined;
	}
}

export function loadConfig(cwd?: string, projectTrusted = false): CompactToolsConfig {
	const globalPath = join(getAgentDir(), CONFIG_FILE);
	const globalConfig = mergeConfig(DEFAULT_CONFIG, readJson(globalPath), globalPath);
	if (!cwd || !projectTrusted) return globalConfig;
	const projectPath = join(cwd, CONFIG_DIR_NAME, CONFIG_FILE);
	return mergeConfig(globalConfig, readJson(projectPath), projectPath);
}
