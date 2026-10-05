export interface NetProfile {
	rttMs: number;

	mbps: number;
}

export const PROFILES: Record<string, NetProfile> = {
	fast: { rttMs: 20, mbps: 100 },
	typical: { rttMs: 80, mbps: 20 },
	slow: { rttMs: 150, mbps: 5 },
};

export type CpuRate = 1 | 4;
