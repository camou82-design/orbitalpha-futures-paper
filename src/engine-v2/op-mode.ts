import type { EngineV2OpMode } from "./types";

/** Unset or invalid `ORBITALPHA_ENGINE_V2_MODE` defaults to engine v2 (not legacy). */
export const DEFAULT_ENGINE_V2_OP_MODE: EngineV2OpMode = "engine_v2";

export function parseEngineV2OpModeFromEnv(raw: string | undefined | null): EngineV2OpMode {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "legacy" || s === "shadow_v2" || s === "engine_v2") return s as EngineV2OpMode;
  return DEFAULT_ENGINE_V2_OP_MODE;
}
