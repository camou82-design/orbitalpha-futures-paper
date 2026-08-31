export type InstrumentTickSzAuthorityInput = Readonly<{
    /** OKX instrument cache tickSz (same source as submitOkxOrder / attachAlgoOrds). */
    instrumentTickSz?: number | null;
    /** Snapshot bridge tickSz propagated from instrument cache at engine boundary. */
    snapshotTickSz?: number | null;
}>;

export type InstrumentTickSzAuthorityResult = Readonly<
    | {
          ok: true;
          tickSz: number;
          source: "instrument_cache.tickSz" | "snapshot.tickSz";
      }
    | {
          ok: false;
          blockReason: "INSTRUMENT_TICK_SZ_UNAVAILABLE";
      }
>;

/**
 * Single tick authority for profitability gate, pre-entry protection plan, and OKX submit normalization.
 * Fail-closed: no symbol hardcoded fallbacks.
 */
export function resolveInstrumentTickSzAuthority(
    input: InstrumentTickSzAuthorityInput
): InstrumentTickSzAuthorityResult {
    if (typeof input.instrumentTickSz === "number" && Number.isFinite(input.instrumentTickSz) && input.instrumentTickSz > 0) {
        return { ok: true, tickSz: input.instrumentTickSz, source: "instrument_cache.tickSz" };
    }
    if (typeof input.snapshotTickSz === "number" && Number.isFinite(input.snapshotTickSz) && input.snapshotTickSz > 0) {
        return { ok: true, tickSz: input.snapshotTickSz, source: "snapshot.tickSz" };
    }
    return { ok: false, blockReason: "INSTRUMENT_TICK_SZ_UNAVAILABLE" };
}
