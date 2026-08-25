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
    lastMicroPatternIdentity: string | null;
    lastDirectionalFailureSignature: string;
}

export interface WhipsawObservationResult {
    episodeId: string | null;
    recheckTicks: number;
    requiredTicks: number;
    resetReason: string | null;
    observationAgePassed: boolean;
    active: boolean;
    freshMicroEvidence: boolean;
    freshStructuralRearm: boolean;
}

const WHIPSAW_REQUIRED_RECHECK_TICKS = 6;

class WhipsawObservationAuthority {
    private episodeBySymbol = new Map<string, WhipsawEpisodeState>();
    private lastReleasedMicroIdentityBySymbol = new Map<string, string>();
    private lastReleasedStructuralSignatureBySymbol = new Map<string, string>();

    private rememberReleasedPattern(symKey: string, episode: WhipsawEpisodeState | undefined): void {
        if (episode?.lastMicroPatternIdentity) {
            this.lastReleasedMicroIdentityBySymbol.set(symKey, episode.lastMicroPatternIdentity);
        }
        if (episode?.lastDirectionalFailureSignature) {
            this.lastReleasedStructuralSignatureBySymbol.set(symKey, episode.lastDirectionalFailureSignature);
        }
    }

    public isMicroPatternFresh(symKey: string, microPatternIdentity: string | null): boolean {
        if (microPatternIdentity == null) return false;
        const episode = this.episodeBySymbol.get(symKey);
        if (microPatternIdentity === (episode?.lastMicroPatternIdentity ?? null)) return false;
        if (microPatternIdentity === (this.lastReleasedMicroIdentityBySymbol.get(symKey) ?? null)) return false;
        return true;
    }

    public isStructuralSignatureFresh(symKey: string, dirFailSig: string): boolean {
        if (!dirFailSig) return false;
        const episode = this.episodeBySymbol.get(symKey);
        if (dirFailSig === (episode?.lastDirectionalFailureSignature ?? "")) return false;
        if (dirFailSig === (this.lastReleasedStructuralSignatureBySymbol.get(symKey) ?? "")) return false;
        return true;
    }

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
        microPatternIdentity?: string | null;
        directionalFailureStructuralHits?: string[];
        now?: number;
    }): WhipsawObservationResult {
        const { symbol, rawActive, directionalShockState, structuralHits, shockEmergencyBypass } = args;
        const symKey = String(symbol).toUpperCase();
        const now = args.now ?? Date.now();
        const currentBypass = shockEmergencyBypass === true;
        const microPatternIdentity = args.microPatternIdentity ?? null;
        const dirFailSig = (args.directionalFailureStructuralHits ?? []).slice().sort().join("|");

        if (!rawActive) {
            const existingBeforeClear = this.episodeBySymbol.get(symKey);
            this.rememberReleasedPattern(symKey, existingBeforeClear);
            if (this.episodeBySymbol.has(symKey)) {
                this.episodeBySymbol.delete(symKey);
            }
            return {
                episodeId: null,
                recheckTicks: 0,
                requiredTicks: WHIPSAW_REQUIRED_RECHECK_TICKS,
                resetReason: null,
                observationAgePassed: false,
                active: false,
                freshMicroEvidence: false,
                freshStructuralRearm: false
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

        const freshMicroEvidence = this.isMicroPatternFresh(symKey, microPatternIdentity);
        const freshStructuralRearm = this.isStructuralSignatureFresh(symKey, dirFailSig);

        if (!existing && (!isHardBlockCandidate || !allowNewHardBlock)) {
            return {
                episodeId: null,
                recheckTicks: 0,
                requiredTicks: WHIPSAW_REQUIRED_RECHECK_TICKS,
                resetReason: null,
                observationAgePassed: false,
                active: false,
                freshMicroEvidence,
                freshStructuralRearm
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

            // 3. Fresh structural invalidation signature (genuine HARD re-arm)
            const isFreshStructuralEpisodeReset = freshStructuralRearm && dirFailSig !== existing.initialStructuralSignature;

            if (isDirectionFlip || isFreshHardShockRisingEdge || isFreshStructuralEpisodeReset) {
                resetReason = isDirectionFlip
                    ? "shock_direction_flip"
                    : isFreshStructuralEpisodeReset
                      ? "fresh_structural_invalidation"
                      : "same_direction_fresh_hard_shock";
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
                    lastShockEmergencyBypass: currentBypass,
                    lastMicroPatternIdentity: microPatternIdentity,
                    lastDirectionalFailureSignature: dirFailSig
                };
                this.episodeBySymbol.set(symKey, existing);
            } else {
                existing.ticks += 1;
                existing.lastSeenAt = now;
                existing.lastResetReason = null;
                existing.lastShockEmergencyBypass = currentBypass;
                if (microPatternIdentity != null) {
                    existing.lastMicroPatternIdentity = microPatternIdentity;
                }
                if (dirFailSig.length > 0) {
                    existing.lastDirectionalFailureSignature = dirFailSig;
                }
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
                lastShockEmergencyBypass: currentBypass,
                lastMicroPatternIdentity: microPatternIdentity,
                lastDirectionalFailureSignature: dirFailSig
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
            active: true,
            freshMicroEvidence,
            freshStructuralRearm
        };
    }

    public clear(symbol?: string): void {
        if (symbol) {
            const symKey = String(symbol).toUpperCase();
            this.rememberReleasedPattern(symKey, this.episodeBySymbol.get(symKey));
            this.episodeBySymbol.delete(symKey);
        } else {
            for (const [symKey, episode] of this.episodeBySymbol.entries()) {
                this.rememberReleasedPattern(symKey, episode);
            }
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
    microPatternIdentity?: string | null;
    directionalFailureStructuralHits?: string[];
    now?: number;
}): WhipsawObservationResult {
    return whipsawObservationAuthority.updateObservation(args);
}

export function clearWhipsawObservationState(symbol?: string): void {
    whipsawObservationAuthority.clear(symbol);
}
