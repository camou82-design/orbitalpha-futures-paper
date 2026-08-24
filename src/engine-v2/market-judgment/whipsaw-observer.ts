export interface WhipsawEpisodeState {
    episodeId: string;
    symbol: string;
    ticks: number;
    firstSeenAt: number;
    lastSeenAt: number;
    initialDirection: "UP" | "DOWN" | "NONE";
    initialStructuralSignature: string;
    lastResetReason: string | null;
    lastShockEmergencyBypass: boolean;
}

export interface WhipsawObservationResult {
    episodeId: string | null;
    recheckTicks: number;
    requiredTicks: number;
    resetReason: string | null;
    observationAgePassed: boolean;
    active: boolean;
}

const WHIPSAW_REQUIRED_RECHECK_TICKS = 6;

class WhipsawObservationAuthority {
    private episodeBySymbol = new Map<string, WhipsawEpisodeState>();

    public updateObservation(args: {
        symbol: string;
        rawActive: boolean;
        directionalShockState: string;
        structuralHits: string[];
        shockEmergencyBypass?: boolean;
        /** True when micro + fresh structural evidence present (hard-block candidate). */
        candidateRiskActive?: boolean;
        /** Gate for starting a new hard-block episode without an existing one. */
        allowNewHardBlockEpisode?: boolean;
        now?: number;
    }): WhipsawObservationResult {
        const { symbol, rawActive, directionalShockState, structuralHits, shockEmergencyBypass } = args;
        const symKey = String(symbol).toUpperCase();
        const now = args.now ?? Date.now();
        const currentBypass = shockEmergencyBypass === true;

        if (!rawActive) {
            if (this.episodeBySymbol.has(symKey)) {
                this.episodeBySymbol.delete(symKey);
            }
            return {
                episodeId: null,
                recheckTicks: 0,
                requiredTicks: WHIPSAW_REQUIRED_RECHECK_TICKS,
                resetReason: null,
                observationAgePassed: false,
                active: false
            };
        }

        const currentDirection: "UP" | "DOWN" | "NONE" =
            directionalShockState === "UP" ? "UP" : directionalShockState === "DOWN" ? "DOWN" : "NONE";
        const structSig = structuralHits.slice().sort().join("|");

        let existing = this.episodeBySymbol.get(symKey);
        let resetReason: string | null = null;

        const isHardBlockCandidate =
            args.candidateRiskActive === true ||
            (args.candidateRiskActive === undefined && rawActive);
        const allowNewHardBlock = args.allowNewHardBlockEpisode ?? true;

        if (!existing && (!isHardBlockCandidate || !allowNewHardBlock)) {
            return {
                episodeId: null,
                recheckTicks: 0,
                requiredTicks: WHIPSAW_REQUIRED_RECHECK_TICKS,
                resetReason: null,
                observationAgePassed: false,
                active: false
            };
        }

        if (existing) {
            // Check for new risk events:
            // 1. Direction flip (UP <-> DOWN)
            const isDirectionFlip =
                existing.initialDirection !== "NONE" &&
                currentDirection !== "NONE" &&
                existing.initialDirection !== currentDirection;

            // 2. Same-direction fresh hard shock: Rising edge of shockEmergencyBypass (false -> true)
            const isFreshHardShockRisingEdge = !existing.lastShockEmergencyBypass && currentBypass;

            if (isDirectionFlip || isFreshHardShockRisingEdge) {
                // If both occur in the same cycle, single reset with priority to direction flip reason
                resetReason = isDirectionFlip ? "shock_direction_flip" : "same_direction_fresh_hard_shock";
                const newEpisodeId = `whipsaw_${symKey}_${now}_${Math.random().toString(36).slice(2, 7)}`;
                existing = {
                    episodeId: newEpisodeId,
                    symbol: symKey,
                    ticks: 1,
                    firstSeenAt: now,
                    lastSeenAt: now,
                    initialDirection: currentDirection,
                    initialStructuralSignature: structSig,
                    lastResetReason: resetReason,
                    lastShockEmergencyBypass: currentBypass
                };
                this.episodeBySymbol.set(symKey, existing);
            } else {
                existing.ticks += 1;
                existing.lastSeenAt = now;
                existing.lastResetReason = null;
                existing.lastShockEmergencyBypass = currentBypass;
            }
        } else {
            const newEpisodeId = `whipsaw_${symKey}_${now}_${Math.random().toString(36).slice(2, 7)}`;
            existing = {
                episodeId: newEpisodeId,
                symbol: symKey,
                ticks: 1,
                firstSeenAt: now,
                lastSeenAt: now,
                initialDirection: currentDirection,
                initialStructuralSignature: structSig,
                lastResetReason: null,
                lastShockEmergencyBypass: currentBypass
            };
            this.episodeBySymbol.set(symKey, existing);
        }

        const recheckTicks = existing.ticks;
        const observationAgePassed = recheckTicks >= WHIPSAW_REQUIRED_RECHECK_TICKS;

        return {
            episodeId: existing.episodeId,
            recheckTicks,
            requiredTicks: WHIPSAW_REQUIRED_RECHECK_TICKS,
            resetReason: existing.lastResetReason,
            observationAgePassed,
            active: true
        };
    }

    public clear(symbol?: string): void {
        if (symbol) {
            this.episodeBySymbol.delete(String(symbol).toUpperCase());
        } else {
            this.episodeBySymbol.clear();
        }
    }

    public getEpisode(symbol: string): WhipsawEpisodeState | undefined {
        return this.episodeBySymbol.get(String(symbol).toUpperCase());
    }
}

export const whipsawObservationAuthority = new WhipsawObservationAuthority();

export function updateWhipsawObservation(args: {
    symbol: string;
    rawActive: boolean;
    directionalShockState: string;
    structuralHits: string[];
    shockEmergencyBypass?: boolean;
    candidateRiskActive?: boolean;
    allowNewHardBlockEpisode?: boolean;
    now?: number;
}): WhipsawObservationResult {
    return whipsawObservationAuthority.updateObservation(args);
}

export function clearWhipsawObservationState(symbol?: string): void {
    whipsawObservationAuthority.clear(symbol);
}
