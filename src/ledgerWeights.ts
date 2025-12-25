// Centralized ledger bit constants and weights
export const LEDGER_BIT_BASE_SHIFT = 6;
export const BIT_ACCOUNT_CREATED = 1 << (LEDGER_BIT_BASE_SHIFT + 0);
export const BIT_ATA_CREATED = 1 << (LEDGER_BIT_BASE_SHIFT + 1);
export const BIT_SAME_AUTH = 1 << (LEDGER_BIT_BASE_SHIFT + 2);
export const BIT_PROGRAM_INIT = 1 << (LEDGER_BIT_BASE_SHIFT + 3);
export const BIT_SLOT_DENSE = 1 << (LEDGER_BIT_BASE_SHIFT + 4);
export const BIT_LP_STRUCT = 1 << (LEDGER_BIT_BASE_SHIFT + 5);
export const BIT_CLEAN_FUNDING = 1 << (LEDGER_BIT_BASE_SHIFT + 6);
export const BIT_SLOT_ALIGNED = 1 << (LEDGER_BIT_BASE_SHIFT + 7);
export const BIT_CREATOR_EXPOSED = 1 << (LEDGER_BIT_BASE_SHIFT + 8);
export const BIT_SOLLET_CREATED = 1 << (LEDGER_BIT_BASE_SHIFT + 9);

// Additional bits for progressive mask (purchase size, buyers, swap/liquidity, fees)
export const BIT_SWAP_DETECTED = 1 << (LEDGER_BIT_BASE_SHIFT + 10);
export const BIT_LIQUIDITY_ADDED = 1 << (LEDGER_BIT_BASE_SHIFT + 11);
export const BIT_WSOL_INTERACTION = 1 << (LEDGER_BIT_BASE_SHIFT + 12);
export const BIT_FIRST_BUY_SMALL = 1 << (LEDGER_BIT_BASE_SHIFT + 13);
export const BIT_FIRST_BUY_MEDIUM = 1 << (LEDGER_BIT_BASE_SHIFT + 14);
export const BIT_FIRST_BUY_LARGE = 1 << (LEDGER_BIT_BASE_SHIFT + 15);
export const BIT_MULTI_BUYERS = 1 << (LEDGER_BIT_BASE_SHIFT + 16);
export const BIT_HIGH_FEE = 1 << (LEDGER_BIT_BASE_SHIFT + 17);
export const BIT_FIRST_BUY = 1 << (LEDGER_BIT_BASE_SHIFT + 18);

// Weights keyed by absolute bit value (used by strategy and engine)
export const LEDGER_WEIGHTS_BY_BIT: Record<number, number> = {
  [BIT_ACCOUNT_CREATED]: 0.06,
  [BIT_ATA_CREATED]: 0.05,
  [BIT_SAME_AUTH]: 0.04,
  [BIT_PROGRAM_INIT]: 0.05,
  [BIT_SLOT_DENSE]: 0.05,
  [BIT_LP_STRUCT]: 0.07,
  [BIT_CLEAN_FUNDING]: 0.08,
  [BIT_SLOT_ALIGNED]: 0.06,
  [BIT_CREATOR_EXPOSED]: 0.08,
  [BIT_SOLLET_CREATED]: 0.06,
  [BIT_SWAP_DETECTED]: 0.08,
  [BIT_LIQUIDITY_ADDED]: 0.08,
  [BIT_WSOL_INTERACTION]: 0.04,
  [BIT_FIRST_BUY_SMALL]: 0.06,
  [BIT_FIRST_BUY_MEDIUM]: 0.12,
  [BIT_FIRST_BUY_LARGE]: 0.2,
  [BIT_MULTI_BUYERS]: 0.09,
  [BIT_HIGH_FEE]: 0.05,
  [BIT_FIRST_BUY]: 0.07,
};

// Weights keyed by bit index (useful for index-based scoring: 1<<index)
export const LEDGER_WEIGHTS_BY_INDEX: Record<number, number> = {};
for (const k of Object.keys(LEDGER_WEIGHTS_BY_BIT)){
  const bitVal = Number(k);
  const idx = Math.log2(bitVal);
  if (Number.isFinite(idx) && Number.isInteger(idx)){
    LEDGER_WEIGHTS_BY_INDEX[idx] = LEDGER_WEIGHTS_BY_BIT[bitVal] as number;
  }
}

export default {
  LEDGER_BIT_BASE_SHIFT,
  BIT_ACCOUNT_CREATED,
  BIT_ATA_CREATED,
  BIT_SAME_AUTH,
  BIT_PROGRAM_INIT,
  BIT_SLOT_DENSE,
  BIT_LP_STRUCT,
  BIT_CLEAN_FUNDING,
  BIT_SLOT_ALIGNED,
  BIT_CREATOR_EXPOSED,
  BIT_SOLLET_CREATED,
  LEDGER_WEIGHTS_BY_BIT,
  LEDGER_WEIGHTS_BY_INDEX,
};
