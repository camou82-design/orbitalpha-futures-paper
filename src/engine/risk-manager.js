"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RiskManager = void 0;
class RiskManager {
    config;
    constructor(config) {
        this.config = config;
    }
    canOpenNewPosition(symbol, existing, side) {
        if (existing)
            return { ok: false, reason: "single_position_only" };
        if (this.config.longOnly && side !== "LONG")
            return { ok: false, reason: "long_only" };
        if (!this.config.symbols.includes(symbol))
            return { ok: false, reason: "symbol_not_allowed" };
        return { ok: true };
    }
}
exports.RiskManager = RiskManager;
