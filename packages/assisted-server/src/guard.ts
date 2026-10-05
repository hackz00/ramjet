import dns from "node:dns";
import net from "node:net";

export type GuardOptions = {
	allowPrivate: boolean;

	dnsTtlMs: number;
};

export const DEFAULT_GUARD: GuardOptions = {
	allowPrivate: false,
	dnsTtlMs: 60_000,
};

function ipv4ToInt(ip: string): number {
	return (
		ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
	);
}

const V4_BLOCKED: [string, number][] = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];

function parseIPv6(input: string): number[] | null {
	let ip = input.toLowerCase().split("%")[0];
	let tail: number[] | null = null;
	const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
	if (dotted) {
		const p = dotted.slice(1).map(Number);
		if (p.some((x) => x > 255)) return null;
		tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
		ip = ip.slice(0, ip.length - dotted[0].length) + "0:0";
	}
	const halves = ip.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
	const groups =
		halves.length === 2
			? [...head, ...Array<string>(missing).fill("0"), ...rest]
			: head;
	const numbers = groups.map((g) =>
		/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN,
	);
	if (numbers.length !== 8 || numbers.some(Number.isNaN)) return null;
	if (tail) numbers.splice(6, 2, tail[0], tail[1]);
	return numbers;
}

const v4FromGroups = (hi: number, lo: number) =>
	`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

export function isPrivateAddress(ip: string): boolean {
	if (net.isIPv4(ip)) {
		const n = ipv4ToInt(ip);
		return V4_BLOCKED.some(([base, bits]) => {
			const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
			return (n & mask) === (ipv4ToInt(base) & mask);
		});
	}
	const g = parseIPv6(ip);
	if (!g) return true;
	const zeros = (from: number, to: number) =>
		g.slice(from, to).every((x) => x === 0);

	if (zeros(0, 5) && g[5] === 0xffff)
		return isPrivateAddress(v4FromGroups(g[6], g[7]));
	if (zeros(0, 6)) return isPrivateAddress(v4FromGroups(g[6], g[7]));
	if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6))
		return isPrivateAddress(v4FromGroups(g[6], g[7]));
	if (g[0] === 0x2002) return isPrivateAddress(v4FromGroups(g[1], g[2]));
	if (g[0] === 0x2001 && g[1] === 0) return true;
	if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
	return (
		(g[0] & 0xfe00) === 0xfc00 ||
		(g[0] & 0xffc0) === 0xfe80 ||
		(g[0] & 0xffc0) === 0xfec0 ||
		(g[0] & 0xff00) === 0xff00
	);
}

type CacheEntry = { addresses: dns.LookupAddress[]; expires: number };

export function createGuardedLookup(options: GuardOptions) {
	const cache = new Map<string, CacheEntry>();
	const pending = new Map<string, Promise<dns.LookupAddress[]>>();

	async function resolve(hostname: string): Promise<dns.LookupAddress[]> {
		const hit = cache.get(hostname);
		if (hit && hit.expires > Date.now()) return hit.addresses;
		let inflight = pending.get(hostname);
		if (!inflight) {
			inflight = dns.promises
				.lookup(hostname, { all: true })
				.then((addresses) => {
					cache.set(hostname, {
						addresses,
						expires: Date.now() + options.dnsTtlMs,
					});
					if (cache.size > 2000)
						cache.delete(cache.keys().next().value as string);
					return addresses;
				});
			pending.set(hostname, inflight);
			inflight.finally(() => pending.delete(hostname)).catch(() => {});
		}
		return inflight;
	}

	const lookup = (
		hostname: string,
		opts: dns.LookupOptions,
		callback: (
			err: NodeJS.ErrnoException | null,
			address: string | dns.LookupAddress[],
			family?: number,
		) => void,
	) => {
		resolve(hostname).then(
			(all) => {
				const usable = options.allowPrivate
					? all
					: all.filter((a) => !isPrivateAddress(a.address));
				if (usable.length === 0) {
					const err: NodeJS.ErrnoException = new Error(
						`blocked address for ${hostname}`,
					);
					err.code = "EBLOCKED";
					return callback(err, "");
				}
				if (opts.all) return callback(null, usable);
				callback(null, usable[0].address, usable[0].family);
			},
			(err) => callback(err, ""),
		);
	};

	return {
		lookup,

		prefetch: (hostname: string) => {
			if (net.isIP(hostname)) return;
			resolve(hostname).catch(() => {});
		},
	};
}
