import { buildPostShockProbeEpisodeId } from "./post-shock-probe-episode";

export const V2_POST_SHOCK_COUNTER_PROBE_SEMANTIC = "V2_POST_SHOCK_COUNTER_PROBE";
export type PostShockProbePromotionState = "PROBE_ONLY" | "STANDARD_PROMOTED";

export interface PostShockProbeLedgerRow {
    symbol?: string;
    side?: string;
    entrySemantic?: string;
    postShockProbeEpisodeId?: string;
    postShockProbePromotionState?: PostShockProbePromotionState;
}

export function gatherPostShockProbeConsumedEpisodeIds(
    openRows: ReadonlyArray<PostShockProbeLedgerRow>,
    closedRows: ReadonlyArray<PostShockProbeLedgerRow> = []
): string[] {
    const ids = new Set<string>();
    for (const row of [...openRows, ...closedRows]) {
        if (row?.entrySemantic !== V2_POST_SHOCK_COUNTER_PROBE_SEMANTIC) continue;
        const id = row.postShockProbeEpisodeId;
        if (typeof id === "string" && id.length > 0) ids.add(id);
    }
    return [...ids];
}

export function isPostShockProbeEpisodeConsumed(input: Readonly<{
    symbol: string;
    side: "long" | "short";
    episodeId: string;
    consumedEpisodeIds: ReadonlyArray<string>;
}>): boolean {
    const id = String(input.episodeId ?? "");
    if (!id) return false;
    return input.consumedEpisodeIds.includes(id);
}

export function resolvePostShockProbeEpisodeForSide(input: Readonly<{
    symbol: string;
    side: "long" | "short";
    shockDirection: "UP" | "DOWN";
    shockExtremumTs: number;
}>): string {
    return buildPostShockProbeEpisodeId({
        symbol: input.symbol,
        shockDirection: input.shockDirection,
        shockExtremumTs: input.shockExtremumTs
    });
}
