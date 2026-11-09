import { ToolExecutionComponent, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { RowRenderers, ToolRow } from "./compact-tools-custom.ts";
import { refreshRowShell, syncNativeToolTimer } from "./compact-tools-rendering.ts";
import type { ToolRuntime } from "./compact-tools-runtime.ts";
import { findChat, isKind } from "./compact-tools-silent.ts";

type Definition = ToolDefinition<any, any, any> | undefined;
export interface UIFailure { operation: string; error: unknown }

/** Attempt every independent cleanup/row action; the caller reports failures once. */
export function attemptUI(failures: UIFailure[], operation: string, action: () => void): void {
	try { action(); } catch (error) { failures.push({ operation, error }); }
}

interface TranscriptOptions {
	runtime: ToolRuntime;
	publicRendering: boolean;
	resolve(row: ToolRow): RowRenderers | undefined;
	definition(name: string, base: Definition): Definition;
	unwrap(definition: Definition): Definition;
}

const WIDGET_KEY = "compact-tools-render";
const emptyWidget = () => ({ render: () => [], invalidate() {} });

/** Own the TUI probe and the private host-row reconciliation boundary together. */
export function createTranscriptRenderer(options: TranscriptOptions) {
	let context: ExtensionContext | undefined;
	let refresh: ((failures: UIFailure[]) => void) | undefined;

	const reconcile = (tui: TUI, failures: UIFailure[]) => {
		const visit = (parent: { children?: unknown[] }) => {
			for (const child of parent.children ?? []) {
				if (!child || typeof child !== "object") continue;
				attemptUI(failures, "tool row", () => {
					if (!isKind(child, ToolExecutionComponent)) { visit(child); return; }
					const row = child as ToolRow & { toolCallId: string; updateDisplay?(): void; callRendererComponent?: unknown; resultRendererComponent?: unknown };
					const base = options.unwrap(row.toolDefinition);
					syncNativeToolTimer(row, row.toolName, base, !options.resolve({ toolName: row.toolName, toolDefinition: base }), options.runtime.timing(row.toolCallId));
					if (options.publicRendering) {
						row.toolDefinition = options.definition(row.toolName, base);
						// Components must not cross native/compact renderer ownership,
						// even when both definitions request the same shell.
						row.callRendererComponent = undefined;
						row.resultRendererComponent = undefined;
					}
					refreshRowShell(row);
					row.updateDisplay?.();
				});
			}
		};
		attemptUI(failures, "transcript", () => {
			const chat = findChat(tui);
			if (chat && chat.children.length > 0) {
				visit(chat);
				attemptUI(failures, "repaint", () => tui.requestRender());
			}
		});
	};

	return {
		bind(ctx: ExtensionContext, failures: UIFailure[]): void {
			context = ctx;
			attemptUI(failures, "renderer probe", () => ctx.ui.setWidget(WIDGET_KEY, (tui) => {
				options.runtime.bindRenderer(() => tui.requestRender());
				refresh = (errors) => reconcile(tui, errors);
				return emptyWidget();
			}, { placement: "belowEditor" }));
			refresh?.(failures);
		},
		refresh(failures: UIFailure[]): void { refresh?.(failures); },
		detach(): void {
			const previous = context;
			context = undefined;
			refresh = undefined;
			options.runtime.bindRenderer(undefined);
			previous?.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
		},
		/** Reconcile provisional startup rows without binding runtime animation. */
		reconcileOnce(ctx: ExtensionContext, failures: UIFailure[]): void {
			if (refresh) { refresh(failures); return; }
			try {
				attemptUI(failures, "startup renderer probe", () => ctx.ui.setWidget(WIDGET_KEY, (tui) => {
					reconcile(tui, failures);
					return emptyWidget();
				}, { placement: "belowEditor" }));
			} finally {
				attemptUI(failures, "startup renderer cleanup", () => ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" }));
			}
		},
	};
}
