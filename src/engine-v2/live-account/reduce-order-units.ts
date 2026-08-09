export type OkxReduceOrderUnits = Readonly<{
  contracts: number;
  ctVal: number;
  baseQty: number;
  referencePrice: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  unitAuthoritySource: "okx_contracts_ctVal_price";
}>;

export function computeOkxReduceOrderUnits(input: Readonly<{
  contracts: number;
  ctVal: number;
  referencePrice: number;
  leverage: number;
}>): OkxReduceOrderUnits {
  const contracts = input.contracts;
  const ctVal = input.ctVal;
  const referencePrice = input.referencePrice;
  const leverage = Math.max(1, input.leverage);
  const baseQty = contracts * ctVal;
  const notionalUsd = baseQty * referencePrice;
  const marginUsd = notionalUsd / leverage;
  return {
    contracts,
    ctVal,
    baseQty,
    referencePrice,
    notionalUsd,
    marginUsd,
    leverage,
    unitAuthoritySource: "okx_contracts_ctVal_price"
  };
}

export function validateOkxReduceOrderUnitInvariant(
  units: OkxReduceOrderUnits,
  tolerance = 0.01
): { pass: boolean; notionalDelta: number; marginDelta: number } {
  const expectedNotional = units.contracts * units.ctVal * units.referencePrice;
  const expectedMargin = units.notionalUsd / units.leverage;
  const notionalDelta = Math.abs(units.notionalUsd - expectedNotional);
  const marginDelta = Math.abs(units.marginUsd - expectedMargin);
  return {
    pass: notionalDelta <= tolerance && marginDelta <= tolerance,
    notionalDelta,
    marginDelta
  };
}
