/**
 * One clock for tool indicators, the working label, and silent activity. The
 * fastest subscriber sets its cadence; slower animations share those frames,
 * keeping their average period with a remainder instead of repainting between
 * indicator frames. With no indicators it returns to the original 80ms cadence.
 */
export const TICK_MS = 80;

type Subscription = { listener: () => void; period: number; elapsed: number };
const listeners = new Set<Subscription>();
let timer: ReturnType<typeof setInterval> | undefined;
let cadence = 0;
let lastTick = 0;

function reschedule(): void {
	const next = listeners.size ? Math.min(...[...listeners].map(({ period }) => period)) : 0;
	if (next === cadence) return;
	const wasRunning = timer !== undefined;
	if (timer) clearInterval(timer);
	timer = undefined;
	cadence = next;
	if (!next) {
		lastTick = 0;
		return;
	}
	if (!wasRunning) lastTick = performance.now();
	timer = setInterval(() => {
		const now = performance.now();
		const step = Math.max(1, Math.round(now - lastTick));
		lastTick = now;
		for (const entry of [...listeners]) {
			if (!listeners.has(entry)) continue;
			entry.elapsed += step;
			if (entry.elapsed < entry.period) continue;
			entry.elapsed %= entry.period;
			entry.listener();
		}
	}, next);
	timer.unref?.();
}

/** Subscribe until disposed. No timer survives the last subscriber. */
export function onTick(listener: () => void, period = TICK_MS): () => void {
	if (!Number.isFinite(period) || period <= 0) throw new RangeError("Animation period must be positive and finite");
	const entry: Subscription = { listener, period, elapsed: 0 };
	listeners.add(entry);
	reschedule();
	return () => {
		listeners.delete(entry);
		reschedule();
	};
}
