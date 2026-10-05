import type { RamjetContext } from "@/shared";
import type { PrefetchHint } from "@rewriters/hints";
import { unrewriteUrl } from "@rewriters/url";
import { _Map } from "@/shared/snapshot";

export type PreconnectTarget = { preconnect?: (origin: string) => void };

const REPEAT_MS = 20_000;

const MAX_PER_SOURCE = 6;
const MAX_REMEMBERED = 256;

export class Preconnector {
	private readonly warmed = new _Map<string, number>();

	readonly stats = { requested: 0 };

	constructor(
		private readonly transport: () => PreconnectTarget | undefined,
		private readonly context: () => RamjetContext,
		private enabled = true,
	) {}

	setEnabled(enabled: boolean) {
		this.enabled = enabled;
	}

	observe(source: URL, hints: PrefetchHint[]): void {
		if (!this.enabled || hints.length === 0) return;
		const transport = this.transport();
		if (typeof transport?.preconnect !== "function") return;

		const context = this.context();
		const prefix = context.prefix.href;
		const now = Date.now();
		let started = 0;
		for (const hint of hints) {
			if (started >= MAX_PER_SOURCE) break;
			if (!hint.url.startsWith(prefix)) continue;
			let origin: string;
			try {
				const real = new URL(unrewriteUrl(hint.url, context));
				if (real.protocol !== "http:" && real.protocol !== "https:") continue;
				origin = real.origin;
			} catch {
				continue;
			}
			if (origin === source.origin) continue;
			const last = this.warmed.get(origin);
			if (last !== undefined && now - last < REPEAT_MS) continue;
			if (this.warmed.size >= MAX_REMEMBERED)
				this.warmed.delete(this.warmed.keys().next().value as string);
			this.warmed.set(origin, now);
			started++;
			this.stats.requested++;
			try {
				transport.preconnect(origin);
			} catch {}
		}
	}
}
