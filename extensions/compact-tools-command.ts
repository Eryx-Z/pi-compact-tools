import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DISPLAY_STYLES, type CompactToolsConfig, type DisplayStyle } from "./compact-tools-types.ts";
import { loadConfig, parseStyle } from "./compact-tools-config.ts";

type Scope = "global" | "project";
const SCOPES: readonly Scope[] = ["global", "project"];
const HELP = "Usage: /compact-tools [claude|off] [global|project]\nWithout a scope the style is saved globally, or to this project when its settings choose the style.\n/compact-tools status · /compact-tools help\nCtrl+O expands rows; /silent toggles quiet mode. All styles, including off, switch at once, even while tools run.";
const BUSY = "Wait for the current response to finish before changing tool styles.";
const CHOICES: Record<DisplayStyle, string> = {
	claude: "Claude — grouped exploration, ⎿ output, and keyword highlighting",
	off: "Off — restore Pi's native UI",
};

export function configPath(cwd: string, scope: Scope): string {
	return scope === "global" ? join(getAgentDir(), "compact-tools.json")
		: join(cwd, CONFIG_DIR_NAME, "compact-tools.json");
}

/** Preserve unrelated and future settings. Never overwrite a malformed file. */
export function saveStyle(path: string, style: DisplayStyle): void {
	let linked = false;
	try {
		linked = lstatSync(path).isSymbolicLink();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (linked) {
		try {
			path = realpathSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			path = resolve(dirname(path), readlinkSync(path));
		}
	}
	let data: Record<string, unknown> = {};
	let mode = 0o600;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		data = parsed as Record<string, unknown>;
		mode = statSync(path).mode & 0o777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	mkdirSync(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.compact-tools-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify({ ...data, style }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		chmodSync(temporary, mode);
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Whether a trusted project's own settings choose the style, which then outranks the global one. */
function projectSetsStyle(cwd: string, trusted: boolean): boolean {
	if (!trusted) return false;
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath(cwd, "project"), "utf8"));
		return !!parsed && typeof parsed === "object" && !Array.isArray(parsed)
			&& parseStyle((parsed as Record<string, unknown>).style) !== undefined;
	} catch {
		return false;
	}
}

function describePath(path: string): string {
	return `${path} (${existsSync(path) ? "exists" : "not created"})`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type ApplyStyle = (cwd: string, trusted: boolean, ctx: ExtensionContext) => boolean;

export function registerCompactToolsCommand(pi: ExtensionAPI, getConfig: () => CompactToolsConfig, applyStyle?: ApplyStyle): void {
	pi.registerCommand("compact-tools", {
		description: "Choose Claude or default tool rows, or show settings and controls",
		getArgumentCompletions: (prefix: string, ctx?: { isProjectTrusted?: () => boolean }) => {
			const typed = prefix.trimStart().replace(/\s+/g, " ").toLowerCase();
			const parts = typed.split(" ");
			const scoped = parts.length === 2 && DISPLAY_STYLES.includes(parts[0] as DisplayStyle);
			const scopes = ctx?.isProjectTrusted?.() === false ? SCOPES.filter((scope) => scope !== "project") : SCOPES;
			const values = scoped ? scopes.map((scope) => `${parts[0]} ${scope}`) : [...DISPLAY_STYLES, "status", "help"];
			const items = values.filter((value) => value.startsWith(typed) && value !== typed.trimEnd()).map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim() ? args.trim().toLowerCase().split(/\s+/) : [];
			if (parts.length === 1 && parts[0] === "help") {
				ctx.ui.notify(HELP, "info");
				return;
			}
			if (parts.length === 1 && parts[0] === "status") {
				const config = getConfig();
				ctx.ui.notify([
					`Style: ${config.style} · configured mode: ${config.mode}`,
					`Global: ${describePath(configPath(ctx.cwd, "global"))}`,
					`Project: ${describePath(configPath(ctx.cwd, "project"))} (${ctx.isProjectTrusted() ? "trusted; overrides global" : "untrusted; ignored"})`,
					"/silent is a session toggle; Ctrl+O expands rows.",
				].join("\n"), "info");
				return;
			}
			const legacy = parts[0] === "compact" || parts[0] === "codex" ? parts[0] : undefined;
			const named = parts[0] === undefined ? undefined : parseStyle(parts[0]);
			if (parts.length > 2 || (parts.length > 0 && !named)
				|| (parts[1] !== undefined && !SCOPES.includes(parts[1] as Scope))) {
				ctx.ui.notify(HELP, "warning");
				return;
			}
			const legacyNote = legacy ? "compact and codex were streamlined into claude. " : "";
			if (named && !ctx.isIdle() && !applyStyle) {
				ctx.ui.notify(BUSY, "warning");
				return;
			}
			let style = named;
			let scope: Scope = (parts[1] as Scope | undefined) ?? (projectSetsStyle(ctx.cwd, ctx.isProjectTrusted()) ? "project" : "global");
			if (!style) {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(HELP, "info");
					return;
				}
				const selected = await ctx.ui.select(`Tool style (current: ${getConfig().style})`, Object.values(CHOICES));
				style = DISPLAY_STYLES.find((value) => CHOICES[value] === selected);
				if (!style) return;
				const projectDecides = projectSetsStyle(ctx.cwd, ctx.isProjectTrusted());
				const scopes = projectDecides
					? ["Project — this trusted project only", "Global — all projects (this project keeps its own style)"]
					: ["Global — all projects", ...(ctx.isProjectTrusted() ? ["Project — this trusted project only"] : [])];
				const selectedScope = await ctx.ui.select("Save style where?", scopes);
				if (!selectedScope) return;
				scope = selectedScope.startsWith("Project") ? "project" : "global";
			}
			if (scope === "project" && !ctx.isProjectTrusted()) {
				ctx.ui.notify("Project settings require a trusted project. No file was changed.", "warning");
				return;
			}
			const reloads = !applyStyle;
			if (reloads && !ctx.isIdle()) {
				ctx.ui.notify(BUSY, "warning");
				return;
			}
			const path = configPath(ctx.cwd, scope);
			try {
				saveStyle(path, style);
			} catch (error) {
				ctx.ui.notify(`Could not save ${path}: ${errorMessage(error)}. No settings were replaced.`, "error");
				return;
			}
			const effective = loadConfig(ctx.cwd, ctx.isProjectTrusted()).style;
			const where = scope === "project" ? "this project" : "global settings";
			if (scope === "global" && effective !== style) {
				ctx.ui.notify(`${legacyNote}Saved ${style} to global settings, but this project keeps its own ${effective} style. Run /compact-tools ${style} to switch it here.`, "warning");
				return;
			}
			if (!reloads && applyStyle!(ctx.cwd, ctx.isProjectTrusted(), ctx)) {
				ctx.ui.notify(`${legacyNote}Switched to ${style} style (saved to ${where}).`, "info");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify(`${legacyNote}Saved ${style} style to ${where}. It applies once the response finishes; run /reload then.`, "warning");
				return;
			}
			ctx.ui.notify(style === "off"
				? `Restoring Pi's native UI (saved to ${where}). Reloading…`
				: `${legacyNote}Switching to ${style} style (saved to ${where}). Reloading…`, "info");
			const ui = ctx.ui;
			try {
				await ctx.reload();
			} catch (error) {
				ui.notify(`Style was saved, but reload failed: ${errorMessage(error)}. Run /reload to apply it.`, "error");
			}
		},
	});
}
