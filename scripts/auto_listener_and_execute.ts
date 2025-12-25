require('dotenv').config();
import fs from 'fs';
import path from 'path';
const sniper = require('../sniper.js');
const { registerBuyWithTarget, monitorAndAutoSellTrades } = require('../src/bot/strategy');
const { unifiedBuy } = require('../src/tradeSources');
const { loadKeypair } = require('../src/wallet');
const rpcPool = require('../src/utils/rpcPool').default || require('../src/utils/rpcPool');
const ledgerAggregator = require('../src/ledgerWindowAggregator').default;
import { LEDGER_BIT_BASE_SHIFT, LEDGER_WEIGHTS_BY_INDEX } from '../src/ledgerWeights';

async function sleep(ms:number){ return new Promise(r=>setTimeout(r,ms)); }

async function main(){
  console.log('Auto-listener starting (will buy 0.01 SOL when progressive mask criteria met).');
  const pkEnv = process.env.PRIVATE_KEY;
  if(!pkEnv){ console.error('PRIVATE_KEY not set in .env — aborting'); process.exit(1); }
  let secret:any = null;
  try{ secret = JSON.parse(pkEnv); }catch(_e){ secret = pkEnv; }
  // load keypair to check balance
  let keypair:any = null;
  try{ keypair = loadKeypair(secret); }catch(e){ console.error('Failed to load keypair from PRIVATE_KEY:', e); process.exit(1); }

  const conn = rpcPool.getRpcConnection();
  if(!conn){ console.error('No RPC connection available'); process.exit(1); }

  // Safety: require LIVE_TRADES & CONFIRM_SEND to be set to perform real sends
  const liveTrades = String(process.env.LIVE_TRADES || 'false').toLowerCase() === 'true';
  const confirmSend = String(process.env.CONFIRM_SEND || 'no').toLowerCase() === 'yes';
  console.log('LIVE_TRADES=', liveTrades, 'CONFIRM_SEND=', confirmSend);
  if(!liveTrades || !confirmSend){ console.warn('Live sends are not enabled (set LIVE_TRADES=true and CONFIRM_SEND=yes to allow real trades). Running in simulation mode only.'); }

  const amount = Number(process.env.AUTO_BUY_AMOUNT || '0.01');
  const minReserve = Number(process.env.MIN_SOL_RESERVE || '0.001');
  const requiredLamports = Math.ceil((amount + minReserve) * 1e9);
  try{
    const bal = await conn.getBalance(keypair.publicKey).catch(()=>0);
    console.log('Bot wallet balance (SOL):', (bal/1e9).toFixed(6));
    if(bal < requiredLamports){ console.error('Insufficient SOL in bot wallet for buy+reserve. Aborting.'); process.exit(1); }
  }catch(e){ console.error('Balance check failed:', e); process.exit(1); }

  const maxRunSec = Number(process.env.AUTO_LISTEN_SECONDS || '300'); // default 5 minutes
  const pollIntervalMs = Number(process.env.AUTO_POLL_MS || '2000');
  const stopAt = Date.now() + maxRunSec * 1000;

  // global counters for diagnostics
  let totalSeen = 0;
  let solletCount = 0;
  let ledgerEvidenceCount = 0;
  let totalAggCountSum = 0;

  // thresholds
  const earlyScoreThreshold = Number(process.env.LEDGER_EARLY_SCORE_THRESHOLD || 0.06);
  const earlyMinBits = Number(process.env.LEDGER_EARLY_MIN_BITS || 2);

  while(Date.now() < stopAt){
    try{
      const collected = await sniper.collectFreshMints({ maxCollect: 3, timeoutMs: 8000 }).catch(()=>[]);
      if(!collected || collected.length===0){
        // no fresh mints this round
        await sleep(pollIntervalMs);
        continue;
      }
      for(const tok of collected){
        try{
          totalSeen++;
          const mint = tok.mint || tok.address || tok.tokenAddress;
          const ledgerMask = Number(tok.ledgerMask || 0);
          const ledgerStrong = !!tok.ledgerStrong;
          // popcount
          let m = ledgerMask; let bits=0; while(m){ bits += m & 1; m >>= 1; }
          // add sample to windowed aggregator
          try{ ledgerAggregator.addSample(mint, { ledgerMask, ledgerStrong, solletCreatedHere: !!tok.solletCreatedHere, sig: tok.sig || tok.txSig || tok.signature }); }catch(_e){}
          const ledgerWindowMs = Number(process.env.LEDGER_WINDOW_MS || process.env.AUTO_WINDOW_MS || '10000');
          const solletWindowMs = Number(process.env.SOLLET_WINDOW_MS || process.env.AUTO_WINDOW_MS || '10000');
          const agg = ledgerAggregator.getAggregated(mint, ledgerWindowMs, solletWindowMs);
          totalAggCountSum += agg.count || 0;
          if(agg.solletCreatedHere) solletCount++;
          if((agg.aggregatedMask||0) !== 0) ledgerEvidenceCount++;
          // compute aggregated score using centralized weights
          const aggregatedScore = ledgerAggregator.computeScoreFromWeights(agg.aggregatedMask, LEDGER_WEIGHTS_BY_INDEX);
          // aggregated popcount
          let aggMask = agg.aggregatedMask || 0; let aggBits = 0; while(aggMask){ aggBits += aggMask & 1; aggMask >>= 1; }

          let mergedSignal = !!agg.mergedSignal || !!tok.mergedSignal || (agg.solletCreatedHere && (agg.aggregatedMask !== 0 || agg.ledgerStrong));
          const solletOnly = String(process.env.SOLLET_ONLY || 'false').toLowerCase() === 'true';
          if(solletOnly && (agg.solletCreatedHere || !!tok.solletCreatedHere)){
            mergedSignal = true; // treat sollet as sufficient when SOLLET_ONLY enabled
          }

          console.log('Found mint', mint, 'sampleBits=', bits, 'sampleMask=', ledgerMask, 'sampleStrong=', ledgerStrong, 'sampleScoreApprox=', (()=>{ let s=0; for(const k of Object.keys(LEDGER_WEIGHTS_BY_INDEX)){ const idx=Number(k); if(ledgerMask & (1<<idx)) s+=LEDGER_WEIGHTS_BY_INDEX[idx]||0;} return s; })(), `\n  ledgerWindowMs=${ledgerWindowMs} solletWindowMs=${solletWindowMs} aggregatedCount=${agg.count} aggregatedMask=${agg.aggregatedMask} aggregatedBits=${aggBits} aggregatedScore=${aggregatedScore} aggBitCounts=${JSON.stringify(agg.bitCounts)} solletHere=${agg.solletCreatedHere} mergedSignal=${mergedSignal} SOLLET_ONLY=${solletOnly}`);

          // Detector-first: require mergedSignal (or sollet-only if enabled) as primary trigger.
          const trigger = mergedSignal || ledgerStrong || aggregatedScore >= earlyScoreThreshold || aggBits >= earlyMinBits;
          if(!trigger){ console.log('Progressive mask criteria not met, skipping'); continue; }

          console.log('Criteria met — attempting buy', mint, 'amount', amount);
          try{
            const buyRes = await unifiedBuy(mint, amount, secret);
            console.log('Buy succeeded:', buyRes);
            // register and immediately monitor to force sell
            const user:any = { id: 'auto_listener_bot', secret, wallet: keypair.publicKey.toBase58(), strategy: { buyAmount: amount, sellPercent1: 100, enabled: true } };
            registerBuyWithTarget(user, { address: mint, price: tok.price || null }, buyRes, user.strategy.targetPercent || 10);
            // call monitor to execute sells immediately
            await monitorAndAutoSellTrades(user, [ { address: mint, ledgerMask: ledgerMask, ledgerStrong: ledgerStrong, solletCreatedHere: !!tok.solletCreatedHere, mergedSignal, price: tok.price || 1 } ]);
            console.log('Buy+immediate-sell flow completed for', mint);
            process.exit(0);
          }catch(e){ console.error('Buy failed or subsequent sell failed:', e); }
        }catch(e){ console.error('Token loop error', e); }
      }
    }catch(e){ console.error('Collector round failed', e); }
    await sleep(pollIntervalMs);
  }
  console.log('Timeout reached, no matching mint executed. Exiting.');
  console.log('--- Summary ---');
  console.log('Total fresh mint groups seen:', totalSeen);
  console.log('Total aggregated sample count (sum of per-mint counts):', totalAggCountSum);
  console.log('Mints with sollet evidence:', solletCount);
  console.log('Mints with any ledger evidence (aggregatedMask != 0):', ledgerEvidenceCount);
  process.exit(0);
}

main().catch(e=>{ console.error('Fatal', e); process.exit(1); });
