import { DEFAULT_CONFIG } from "./compact-tools-config.ts";
import { onTick } from "./compact-tools-clock.ts";
import { isSilent } from "./compact-tools-silent.ts";
import type { CompactToolsConfig, RenderContext, RowState } from "./compact-tools-types.ts";

const MAX_TRACKED_ROWS = 2_000;
const INDICATOR_INTERVAL_MS = 45;
const UNDRAWN_ROW_MS = 1_500;
const EXECUTION_TIMINGS_KEY = Symbol.for("pi.compact-tools.execution-timings");

type ExecutionTiming = { startedAt: number; endedAt?: number; durationMs?: number };

export function validDurationMs(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
type Indicator = { invalidate: () => void; drawnAt: number };
type SharedState = typeof globalThis & {
	[EXECUTION_TIMINGS_KEY]?: Map<string, ExecutionTiming>;
};

export class ToolRuntime {
	private configValue = DEFAULT_CONFIG;
	private configRevision: object = {};
	private readonly executionTimings: Map<string, ExecutionTiming>;
	private readonly indicators = new Map<string, Indicator>();
	private indicatorFrame = 0;
	private stopIndicatorTicks: (() => void) | undefined;
	private requestRender: (() => void) | undefined;
	private busy: boolean | undefined;
	private readonly currentCalls = new Set<string>();

	constructor(private readonly clock: () => number = () => performance.now()) {
		const shared = globalThis as SharedState;
		this.executionTimings = shared[EXECUTION_TIMINGS_KEY] ?? new Map<string, ExecutionTiming>();
		shared[EXECUTION_TIMINGS_KEY] = this.executionTimings;
	}

	get config(): CompactToolsConfig {
		return this.configValue;
	}

	get frame(): number {
		return this.indicatorFrame;
	}

	timing(toolCallId: string): Readonly<ExecutionTiming> | undefined {
		return this.executionTimings.get(toolCallId);
	}

	configure(config: CompactToolsConfig): void {
		this.configValue = config;
		this.configRevision = {};
	}

	clearTimings(): void {
		this.executionTimings.clear();
	}

	reset(clearTimings: boolean): void {
		this.stopIndicators();
		if (clearTimings) this.clearTimings();
	}

	bindRenderer(requestRender: (() => void) | undefined): void {
		this.requestRender = requestRender;
	}

	repaint(): void {
		if (!isSilent()) this.requestRender?.();
	}

	setBusy(busy: boolean): void {
		if (busy && this.busy !== true) {
			this.currentCalls.clear();
		}
		this.busy = busy;
		if (busy) return;
		const animating = this.indicators.size > 0;
		this.stopIndicators();
		if (animating) this.requestRender?.();
	}

	noteCall(toolCallId: string): void {
		this.currentCalls.add(toolCallId);
	}

	canRun(toolCallId: string): boolean {
		return this.busy === undefined || (this.busy && this.currentCalls.has(toolCallId));
	}

	syncIndicator(toolCallId: string, running: boolean, invalidate: () => void): number {
		if (!running) {
			this.removeIndicator(toolCallId);
			return 0;
		}
		const indicator = this.indicators.get(toolCallId);
		if (indicator) {
			indicator.invalidate = invalidate;
			indicator.drawnAt = this.clock();
		} else {
			this.indicators.set(toolCallId, { invalidate, drawnAt: this.clock() });
		}
		this.stopIndicatorTicks ??= onTick(() => this.tick(), INDICATOR_INTERVAL_MS);
		return this.indicatorFrame;
	}

	keepAnimating(toolCallId: string): void {
		const indicator = this.indicators.get(toolCallId);
		if (indicator) indicator.drawnAt = this.clock();
	}

	syncExpansion(state: RowState, hostExpanded: boolean, _name?: string): boolean {
		const initialized = this.initializeExpansion(state, hostExpanded);
		if (!initialized && state.lastHostExpanded !== hostExpanded) {
			state.lastHostExpanded = hostExpanded;
			state.expanded = hostExpanded;
		}
		return state.expanded ?? false;
	}

	setResultAvailable(state: RowState, _name: string, available: boolean): void {
		this.initializeExpansion(state);
		state.hasResult = available;
	}

	syncRow(ctx: RenderContext, finished = false): RowState {
		const state = ctx.state;
		this.restoreTiming(state, ctx.toolCallId);
		if (validDurationMs(ctx.durationMs)) state.durationMs = ctx.durationMs;
		const started = this.canRun(ctx.toolCallId) && ctx.executionStarted;
		if (started && state.startedAt === undefined) state.startedAt = Date.now();
		if (finished) state.finished = true;
		if (finished && state.startedAt !== undefined && state.endedAt === undefined) state.endedAt = Date.now();
		if (finished) this.removeIndicator(ctx.toolCallId);
		this.persistTiming(state, ctx.toolCallId);
		return state;
	}

	noteExecutionStart(toolCallId: string): void {
		if (!this.executionTimings.has(toolCallId)) this.executionTimings.set(toolCallId, { startedAt: Date.now() });
		this.trimTimings();
	}

	noteExecutionEnd(toolCallId: string, durationMs?: number): void {
		const timing = this.executionTimings.get(toolCallId) ?? { startedAt: Date.now() };
		timing.endedAt ??= Date.now();
		if (validDurationMs(durationMs)) timing.durationMs = durationMs;
		this.executionTimings.set(toolCallId, timing);
		this.trimTimings();
	}

	private tick(): void {
		this.indicatorFrame++;
		const requestRender = this.requestRender;
		if (requestRender) {
			const oldest = this.clock() - UNDRAWN_ROW_MS;
			for (const [toolCallId, indicator] of this.indicators) {
				if (indicator.drawnAt < oldest) this.removeIndicator(toolCallId);
			}
			if (this.indicators.size === 0) return;
		}
		if (isSilent()) return;
		if (requestRender) {
			requestRender();
			return;
		}
		for (const { invalidate } of this.indicators.values()) invalidate();
	}

	private removeIndicator(toolCallId: string): void {
		this.indicators.delete(toolCallId);
		if (this.indicators.size > 0) return;
		this.stopIndicatorTicks?.();
		this.stopIndicatorTicks = undefined;
		this.indicatorFrame = 0;
	}

	private stopIndicators(): void {
		this.stopIndicatorTicks?.();
		this.stopIndicatorTicks = undefined;
		this.indicators.clear();
		this.indicatorFrame = 0;
	}

	private initializeExpansion(state: RowState, hostExpanded = false): boolean {
		if (state.configRevision === this.configRevision) return false;
		state.configRevision = this.configRevision;
		state.lastHostExpanded = hostExpanded;
		state.expanded = hostExpanded;
		return true;
	}

	private restoreTiming(state: RowState, toolCallId: string): void {
		const timing = this.executionTimings.get(toolCallId);
		if (!timing) return;
		state.startedAt = timing.startedAt;
		state.endedAt = timing.endedAt;
		if (validDurationMs(timing.durationMs)) state.durationMs = timing.durationMs;
	}

	private persistTiming(state: RowState, toolCallId: string): void {
		if (state.startedAt === undefined) return;
		const timing = this.executionTimings.get(toolCallId) ?? { startedAt: state.startedAt };
		timing.startedAt = state.startedAt;
		if (state.endedAt !== undefined) timing.endedAt = state.endedAt;
		if (validDurationMs(state.durationMs)) timing.durationMs = state.durationMs;
		this.executionTimings.set(toolCallId, timing);
		this.trimTimings();
	}

	private trimTimings(): void {
		if (this.executionTimings.size <= MAX_TRACKED_ROWS) return;
		for (const [id, timing] of this.executionTimings) {
			if (timing.endedAt !== undefined) {
				this.executionTimings.delete(id);
				return;
			}
		}
		const oldest = this.executionTimings.keys().next().value;
		if (oldest !== undefined) this.executionTimings.delete(oldest);
	}
}
