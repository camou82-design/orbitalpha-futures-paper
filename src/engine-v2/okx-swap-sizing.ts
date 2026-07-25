export interface OkxSwapInstrumentSizing {
  lotSz: number;
  minSz: number;
  ctVal: number;
  ctValCcy: string;
}

export function okxInstrumentSzDecimals(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const s = String(n);
  if (/e/i.test(s)) {
    const x = Number.parseFloat(s);
    const t = x.toFixed(12);
    const i = t.indexOf(".");
    return i < 0 ? 0 : Math.min(12, t.replace(/0+$/, "").length - i - 1);
  }
  const i = s.indexOf(".");
  return i < 0 ? 0 : Math.min(12, s.length - i - 1);
}

export function formatOkxSwapContractSzString(n: number, lotSz: number): string {
  const d = Math.max(okxInstrumentSzDecimals(lotSz), okxInstrumentSzDecimals(n));
  let out = n.toFixed(Math.min(Math.max(d, 0), 12));
  if (out.includes(".")) out = out.replace(/\.?0+$/, "");
  return out.length > 0 ? out : "0";
}

/** Linear USDT-margined SWAP: contracts = notionalUSDT / (lastPrice * ctVal); sz must be lotSz multiple and >= minSz. */
export function normalizeOkxSwapContractsFromNotional(args: {
  desiredNotionalUsdt: number;
  lastPrice: number;
  sizing: OkxSwapInstrumentSizing;
}): {
  raw_contracts: number;
  normalized_contracts: number;
  normalized_sz: string;
  sz_lot_multiple_ok: boolean;
  min_size_ok: boolean;
  actualNotional: number;
} {
  const { sizing } = args;
  const denom = args.lastPrice * sizing.ctVal;
  const raw_contracts = denom > 1e-24 ? args.desiredNotionalUsdt / denom : 0;
  const lot = sizing.lotSz;
  let steps = Math.floor(raw_contracts / lot + 1e-12);
  let normalized_contracts = steps * lot;
  while (denom > 0 && steps > 0 && normalized_contracts * denom > args.desiredNotionalUsdt + 1e-9) {
    steps--;
    normalized_contracts = steps * lot;
  }
  normalized_contracts = Number(
    normalized_contracts.toFixed(Math.min(12, Math.max(okxInstrumentSzDecimals(lot), okxInstrumentSzDecimals(normalized_contracts))))
  );
  const normalized_sz = formatOkxSwapContractSzString(normalized_contracts, lot);
  const roundTol = Math.max(1e-10, Math.abs(normalized_contracts) * 1e-9);
  const sz_lot_multiple_ok =
    steps >= 0 &&
    Number.isFinite(normalized_contracts) &&
    Math.abs(normalized_contracts - steps * lot) <= roundTol + 1e-12;
  const min_size_ok = normalized_contracts + 1e-12 >= sizing.minSz;
  const actualNotional = normalized_contracts * denom;
  return {
    raw_contracts,
    normalized_contracts,
    normalized_sz,
    sz_lot_multiple_ok,
    min_size_ok,
    actualNotional
  };
}
