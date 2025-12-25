#!/usr/bin/env ts-node
import fs from 'fs';
import path from 'path';
const aggregator = require('../src/ledgerWindowAggregator').default;
const { LedgerSignalEngine } = require('../src/simulation/ledger_signal_engine');
const lw = require('../src/ledgerWeights');

function bitListFromMask(mask: number){
  const bits: number[] = [];
  let idx = 0; let m = mask;
  while(m){ if(m & 1) bits.push(idx); idx++; m >>>= 1; }
  return bits;
}

async function main(){
  const samplesPath = path.join(__dirname, 'raw_samples_only.json');
  if(!fs.existsSync(samplesPath)) throw new Error('raw_samples_only.json missing');
  const samples = JSON.parse(fs.readFileSync(samplesPath,'utf8')) as any[];
  const sample = samples[0];
  const mint = process.argv[2] || sample.mint;

  // reset aggregator internal state (quick hack)
  try{ (aggregator as any).map = new Map(); (aggregator as any).seenSigs = new Map(); }catch(e){}

  const engine = new LedgerSignalEngine({ windowSlots: 5, densityThreshold: 2, requiredBits: 2 });

  console.log('Simulating trade cycle for mint', mint);

  // Simulate BUY: medium first-buy + swap + sollet-created
  const buyMask = (lw.BIT_FIRST_BUY_MEDIUM) | (lw.BIT_FIRST_BUY) | (lw.BIT_SWAP_DETECTED) | (lw.BIT_SOLLET_CREATED);
  aggregator.addSample(mint, { ledgerMask: buyMask, ledgerStrong: true, solletCreatedHere: true, sig: 'buy-1' });
  engine.processEvent({ slot: Date.now() % 1_000_000, freshMints: [mint], sampleLogs: 'simulated buy', solletCreated: true, transaction: null, meta: null });

  const agg1 = aggregator.getAggregated(mint);
  const score1 = aggregator.computeScoreFromWeights(agg1.aggregatedMask, lw.LEDGER_WEIGHTS_BY_INDEX);

  console.log('\n=== After BUY ===');
  console.log('Aggregated Mask:', agg1.aggregatedMask, 'bits:', bitListFromMask(agg1.aggregatedMask));
  console.log('BitCounts:', agg1.bitCounts);
  console.log('LedgerStrong:', agg1.ledgerStrong, 'SolletCreatedHere:', agg1.solletCreatedHere);
  console.log('Score:', score1.toFixed(3));

  // Simulate SELL: swap + liquidity removed + high fee
  const sellMask = (lw.BIT_SWAP_DETECTED) | (lw.BIT_LIQUIDITY_ADDED) | (lw.BIT_HIGH_FEE);
  aggregator.addSample(mint, { ledgerMask: sellMask, ledgerStrong: true, solletCreatedHere: false, sig: 'sell-1' });
  engine.processEvent({ slot: Date.now() % 1_000_000 + 1, freshMints: [mint], sampleLogs: 'simulated sell', solletCreated: false, transaction: null, meta: null });

  const agg2 = aggregator.getAggregated(mint);
  const score2 = aggregator.computeScoreFromWeights(agg2.aggregatedMask, lw.LEDGER_WEIGHTS_BY_INDEX);

  console.log('\n=== After SELL ===');
  console.log('Aggregated Mask:', agg2.aggregatedMask, 'bits:', bitListFromMask(agg2.aggregatedMask));
  console.log('BitCounts:', agg2.bitCounts);
  console.log('LedgerStrong:', agg2.ledgerStrong, 'SolletCreatedHere:', agg2.solletCreatedHere);
  console.log('Score:', score2.toFixed(3));

  // Show derived decision: simple threshold
  const threshold = Number(process.env.MASK_SCORE_THRESHOLD || 0.2);
  console.log('\nDecision: score', score2.toFixed(3), '> threshold', threshold, '=>', score2 >= threshold ? 'BUY/ALERT' : 'NO ACTION');
}

main().catch(e=>{ console.error(e); process.exit(1); });
