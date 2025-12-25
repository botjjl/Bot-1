#!/usr/bin/env ts-node
import aggregator from '../src/ledgerWindowAggregator';
import { LEDGER_WEIGHTS_BY_INDEX } from '../src/ledgerWeights';

const mint = process.argv[2] || '';
const intervalMs = Number(process.env.MONITOR_INTERVAL_MS || 2000);
const durationMs = Number(process.env.MONITOR_DURATION_MS || 60_000);

function computeScore(mask:number){
  let score = 0;
  for(const k of Object.keys(LEDGER_WEIGHTS_BY_INDEX)){
    const idx = Number(k);
    const bit = 1<<idx;
    if(mask & bit) score += LEDGER_WEIGHTS_BY_INDEX[idx] || 0;
  }
  return score;
}

console.log('Monitoring mint', mint, `every ${intervalMs}ms for ${durationMs}ms`);
const start = Date.now();
const t = setInterval(()=>{
  const agg = aggregator.getAggregated(mint);
  const score = computeScore(agg.aggregatedMask);
  console.log(new Date().toISOString(), 'count=', agg.count, 'mask=', agg.aggregatedMask, 'bits=', agg.bitCounts, 'sollet=', agg.solletCreatedHere, 'score=', score.toFixed(3));
  if(Date.now() - start > durationMs){ clearInterval(t); process.exit(0); }
}, intervalMs);
