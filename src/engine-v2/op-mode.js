"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ENGINE_V2_OP_MODE = void 0;
exports.parseEngineV2OpModeFromEnv = parseEngineV2OpModeFromEnv;
/** Unset or invalid `ORBITALPHA_ENGINE_V2_MODE` defaults to engine v2 (not legacy). */
exports.DEFAULT_ENGINE_V2_OP_MODE = "engine_v2";
function parseEngineV2OpModeFromEnv(raw) {
    const s = String(raw ?? "").trim().toLowerCase();
    if (s === "legacy" || s === "shadow_v2" || s === "engine_v2")
        return s;
    return exports.DEFAULT_ENGINE_V2_OP_MODE;
}
