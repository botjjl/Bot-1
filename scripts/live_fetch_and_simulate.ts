#!/usr/bin/env ts-node
import rpcPool = require('../src/utils/rpcPool');
import { PublicKey } from '@solana/web3.js';
const aggregator = require('../src/ledgerWindowAggregator').default;
const { LedgerSignalEngine } = require('../src/simulation/ledger_signal_engine');
const liquidity = require('../src/simulation/liquidity').default || require('../src/simulation/liquidity');
import fs from 'fs';
import path from 'path';

async function sleep(ms:number){ return new Promise(r=>setTimeout(r,ms)); }

async function fetchRecentTxForMint(mint:string){
  try{
    const conn = rpcPool.getRpcConnection({ commitment: 'finalized' });
    const sigs = await (conn as any).getSignaturesForAddress(new PublicKey(mint), { limit: 20 });
    if(!sigs || sigs.length===0) return null;
    for(const s of sigs){
      try{
        const tx = await (conn as any).getParsedTransaction(s.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
        if(tx) return { tx, sig: s.signature, slot: s.slot, blockTime: s.blockTime };
      }catch(e){ /* continue */ }
      await sleep(150);
    }
  }catch(e){ /* ignore */ }
  return null;
}

async function countHolders(mint:string){
  try{
    const conn = rpcPool.getRpcConnection({ commitment: 'finalized' }) as any;
    const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    // fetch parsed token accounts for this mint (may be heavy; limited by RPC)
    const resp = await conn.getParsedProgramAccounts(TOKEN_PROGRAM, { filters: [ { memcmp: { offset: 0, bytes: mint } }, { dataSize: 165 } ] });
    if(!resp || !Array.isArray(resp)) return 0;
    let count = 0;
    for(const acc of resp){
      try{
        const info = acc.account && acc.account.data && acc.account.data.parsed && acc.account.data.parsed.info;
        const amt = info && info.tokenAmount && (typeof info.tokenAmount.uiAmount === 'number') ? Number(info.tokenAmount.uiAmount) : 0;
        if(amt && amt > 0) count++;
      }catch(e){}
    }
    return count;
  }catch(e){ return -1; }
}

async function inspectMint(mint:string){
  const conn = rpcPool.getRpcConnection({ commitment: 'finalized' });
  let accountInfo = null as any;
  try{ accountInfo = await conn.getAccountInfo(new PublicKey(mint)); }catch(e){}
  let decoded = null;
  try{ if(accountInfo && accountInfo.data){ const Buffer = require('buffer').Buffer; const layout = require('@solana/buffer-layout'); const { struct, u32, u8 } = layout; } }catch(e){}
  return { accountInfo };
}

function bitListFromMask(mask:number){ const bits:number[]=[]; let idx=0; let m=mask; while(m){ if(m&1) bits.push(idx); idx++; m>>>=1; } return bits; }

async function main(){
  const samplesPath = path.join(__dirname, 'raw_samples_only.json');
  if(!fs.existsSync(samplesPath)) throw new Error('raw_samples_only.json missing');
  const samples = JSON.parse(fs.readFileSync(samplesPath,'utf8')) as any[];
  const mint = process.argv[2] || samples[0].mint;
  console.log('Running live fetch+simulate for mint', mint);

  // recent tx
  const fetched = await fetchRecentTxForMint(mint);
  console.log('Recent tx fetch:', fetched ? `sig=${fetched.sig} slot=${fetched.slot} time=${new Date((fetched.blockTime||0)*1000).toISOString()}` : 'none');

  // count holders
  const holders = await countHolders(mint);
  console.log('Holders count (token accounts with balance>0):', holders);

  // liquidity via Jupiter (estimate price in SOL for small trade)
  let liq:any = null;
  try{ liq = await liquidity.checkLiquidityOnJupiter(mint, 1); }catch(e){ liq = { tradable:false, note: String(e) }; }
  console.log('Liquidity check (Jupiter):', liq && liq.tradable ? `tradable, estPriceSol=${liq.estimatedPriceSol} priceImpact=${liq.priceImpact}` : `not tradable (${liq && liq.note})`);

  // creation / launch recency: attempt earliest signature
  let createdAt = null;
  try{
    const conn = rpcPool.getRpcConnection({ commitment: 'finalized' });
    const sigs = await conn.getSignaturesForAddress(new PublicKey(mint), { limit: 1000 });
    if(sigs && sigs.length){ const last = sigs[sigs.length-1]; createdAt = last.blockTime ? new Date(last.blockTime*1000).toISOString() : null; }
  }catch(e){}
  console.log('Approx creation time (earliest signature in limited window):', createdAt || 'unknown');

  // run engine + aggregator probe
  // reset aggregator state for deterministic output
  try{ (aggregator as any).map = new Map(); (aggregator as any).seenSigs = new Map(); }catch(e){}
  const engine = new LedgerSignalEngine({ windowSlots: 5, densityThreshold: 2, requiredBits: 2 });

  // If we got a recent tx, feed it into engine
  if(fetched && fetched.tx){
    const ev:any = { slot: fetched.slot || Date.now()%1_000_000, freshMints: [mint], sampleLogs: JSON.stringify(fetched.tx || {}), solletCreated: false, transaction: fetched.tx.transaction || null, meta: fetched.tx.meta || null };
    engine.processEvent(ev);
  }

  const mask = engine.getMaskForMint(mint, null);
  console.log('Derived ledger mask from engine:', mask, 'bits:', bitListFromMask(mask));

  // Simulate a buy via aggregator and engine as demonstration
  const lw = require('../src/ledgerWeights');
  const buyMask = (lw.BIT_FIRST_BUY_MEDIUM || 0) | (lw.BIT_FIRST_BUY || 0) | (lw.BIT_SWAP_DETECTED || 0) | (lw.BIT_SOLLET_CREATED || 0);
  aggregator.addSample(mint, { ledgerMask: buyMask, ledgerStrong: true, solletCreatedHere: true, sig: 'sim-buy-1' });
  engine.processEvent({ slot: Date.now()%1_000_000 + 1, freshMints: [mint], sampleLogs: 'simulated buy', solletCreated: true, transaction: null, meta: null });

  const agg = aggregator.getAggregated(mint);
  const weights = require('../src/ledgerWeights').LEDGER_WEIGHTS_BY_INDEX || require('../src/ledgerWeights').LEDGER_WEIGHTS_BY_BIT;
  const score = aggregator.computeScoreFromWeights(agg.aggregatedMask, weights);

  console.log('\n=== After simulated BUY ===');
  console.log('Aggregated Mask:', agg.aggregatedMask, 'bits:', bitListFromMask(agg.aggregatedMask));
  console.log('BitCounts:', agg.bitCounts);
  console.log('SolletCreatedHere:', agg.solletCreatedHere, 'LedgerStrong:', agg.ledgerStrong);
  console.log('Score:', score.toFixed(3));
}

main().catch(e=>{ console.error('Error', e); process.exit(1); });
