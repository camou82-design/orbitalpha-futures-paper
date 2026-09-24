/**
 * @deprecated In-memory latch removed — ledger episode ids are authoritative.
 * Kept for test imports migrating to post-shock-probe-episode-authority.
 */
export {
    gatherPostShockProbeConsumedEpisodeIds,
    isPostShockProbeEpisodeConsumed as isPostShockCounterProbeConsumed,
    V2_POST_SHOCK_COUNTER_PROBE_SEMANTIC
} from "./post-shock-probe-episode-authority";

export { buildPostShockProbeEpisodeId, buildPostShockProbeEpisodeId as buildPostShockCounterProbeLatchKey } from "./post-shock-probe-episode";

/** No-op: consumption is ledger-backed only. */
export function markPostShockCounterProbeConsumed(_key: string): void {}

/** No-op for tests that reset legacy latch. */
export function resetPostShockCounterProbeLatchForTests(): void {}
