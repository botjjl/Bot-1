import fs from 'fs';
import path from 'path';
// use require for JS module sniper
const sniper = require('../sniper.js');
const { registerBuyWithTarget } = require('../src/bot/strategy');

async function main(){
  console.log('Live fetch + simulate starting...');
  const maxCollect = 1;
  const tokens = await sniper.collectFreshMints({ maxCollect, timeoutMs: 20000 }).catch((e:any)=>{ console.error('collectFreshMints failed', e); return []; });
  if(!tokens || tokens.length===0){ console.error('No fresh mints found'); process.exit(1); }
  const tok = tokens[0];
  console.log('Collected token:', tok);

  // load user
  const usersFile = path.join(process.cwd(), 'users.json');
  const users = JSON.parse(fs.readFileSync(usersFile,'utf8'));
  const userId = Object.keys(users)[0];
  const user = users[userId];
  user.id = userId;
  console.log('Using user:', userId);

  // Optionally force a ledger mask to simulate immediate execution (set env FORCE_IMMEDIATE=1)
  if(process.env.FORCE_IMMEDIATE === '1'){
    // set a mask with a couple of ledger bits to exceed default thresholds
    tok.ledgerMask = tok.ledgerMask || (1 << (6 + 0)) | (1 << (6 + 5));
    tok.ledgerStrong = true;
    tok.solletCreatedHere = true;
  }

  // Prepare simulated buy: pick entry price (from token if available) or default
  const entryPrice = (tok && (tok.price || tok.priceUsd)) ? Number(tok.price || tok.priceUsd) : 1.0;
  const buyResult = { tx: `SIM_BUY_${Date.now()}` };

  // register buy and auto-sells (writes sent_tokens/<userId>.json)
  registerBuyWithTarget(user, { address: tok.mint || tok.address || tok.tokenAddress, price: entryPrice }, buyResult, user.strategy && user.strategy.targetPercent || 10);
  console.log('Registered simulated buy and sell orders in sent_tokens');

  // Read back pending sells
  const sentTokensDir = path.join(process.cwd(), 'sent_tokens');
  const userFile = path.join(sentTokensDir, `${userId}.json`);
  if(!fs.existsSync(userFile)){ console.error('user trades file missing'); process.exit(1); }
  const trades = JSON.parse(fs.readFileSync(userFile,'utf8')) as any[];
  console.log('Trades after register:', trades);

  // Determine early-execution: compute ledger mask/score and current price that triggers early sell
  const ledgerMask = Number(tok.ledgerMask || 0);
  const ledgerStrong = !!tok.ledgerStrong;
  const maskPopcount = (n:number)=>{ let c=0; while(n){ c+=n&1; n>>=1;} return c; };
  const maskBits = maskPopcount(ledgerMask);
  console.log('Token ledgerMask=', ledgerMask, 'maskBits=', maskBits, 'ledgerStrong=', ledgerStrong, 'sollet=', !!tok.solletCreatedHere);

  // Use same scoring as strategy.ts
  const LEDGER_BIT_BASE_SHIFT = 6;
  const BIT_ACCOUNT_CREATED = 1 << (LEDGER_BIT_BASE_SHIFT + 0);
  const BIT_ATA_CREATED = 1 << (LEDGER_BIT_BASE_SHIFT + 1);
  const BIT_SAME_AUTH = 1 << (LEDGER_BIT_BASE_SHIFT + 2);
  const BIT_PROGRAM_INIT = 1 << (LEDGER_BIT_BASE_SHIFT + 3);
  const BIT_SLOT_DENSE = 1 << (LEDGER_BIT_BASE_SHIFT + 4);
  const BIT_LP_STRUCT = 1 << (LEDGER_BIT_BASE_SHIFT + 5);
  const BIT_CLEAN_FUNDING = 1 << (LEDGER_BIT_BASE_SHIFT + 6);
  const BIT_SLOT_ALIGNED = 1 << (LEDGER_BIT_BASE_SHIFT + 7);
  const BIT_CREATOR_EXPOSED = 1 << (LEDGER_BIT_BASE_SHIFT + 8);
  const BIT_SOLLET_CREATED = 1 << (LEDGER_BIT_BASE_SHIFT + 9);
  const LEDGER_WEIGHTS:any = {
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
  };
  const ledgerScoreFromMask = (mask:number)=>{ let s=0; for(const k of Object.keys(LEDGER_WEIGHTS)){ const bit = Number(k); if(mask & bit) s += LEDGER_WEIGHTS[k]||0; } return s; };
  const ledgerScore = ledgerScoreFromMask(ledgerMask);
  console.log('ledgerScore=', ledgerScore);

  const earlyThresholdFactor = Number(process.env.LEDGER_EARLY_THRESHOLD_FACTOR || '0.01');
  const earlyScoreThreshold = Number(process.env.LEDGER_EARLY_SCORE_THRESHOLD || (user.strategy && user.strategy.minLedgerScore) || 0.06);
  const earlyMinBits = Number(process.env.LEDGER_EARLY_MIN_BITS || 2);

  // Find pending sells linked to our simulated buy
  const pendingSells = trades.filter(t => t.mode === 'sell' && t.status === 'pending' && t.linkedBuyTx === buyResult.tx);
  console.log('Pending sells:', pendingSells);
  if(pendingSells.length === 0){ console.error('No pending sells found after registering buy'); process.exit(1); }

  // Choose a currentPrice that will trigger early execution if possible
  const sell = pendingSells[0];
  const entry = sell.entryPrice || entryPrice;
  const triggerPrice = entry * (1 + (earlyThresholdFactor + 0.001));
  console.log('Entry price=', entry, 'triggerPrice=', triggerPrice);

  const shouldEarly = (ledgerStrong || ledgerScore >= earlyScoreThreshold || maskBits >= earlyMinBits) && (triggerPrice >= entry * (1 + earlyThresholdFactor));
  console.log('Early decision =>', shouldEarly, ' (ledgerStrong,ledgerScore,maskBits)=', ledgerStrong, ledgerScore, maskBits);

  if(shouldEarly){
    // Mark the sell order as simulated executed (no real tx)
    const sellTx = `SIM_SELL_${Date.now()}`;
    for(const s of trades){ if(s.linkedBuyTx === buyResult.tx && s.mode === 'sell' && s.status==='pending'){
      s.status = 'success'; s.tx = sellTx; s.executedTime = Date.now(); s.note = 'simulated early-execution'; s.earlyTriggeredBy = s.earlyTriggeredBy || [];
      if(ledgerStrong) s.earlyTriggeredBy.push('ledgerStrong');
      if(ledgerScore >= earlyScoreThreshold) s.earlyTriggeredBy.push('ledgerScore');
      if(maskBits >= earlyMinBits) s.earlyTriggeredBy.push('ledgerMaskBits');
    }}
    fs.writeFileSync(userFile, JSON.stringify(trades, null, 2));
    console.log('Early sell simulated and recorded. Updated trades:', trades.filter(t=>t.mode==='sell'));
  } else {
    console.log('Early execution conditions not met. No sell simulated.');
  }

  process.exit(0);
}

main().catch((e)=>{ console.error('Error', e); process.exit(1); });
