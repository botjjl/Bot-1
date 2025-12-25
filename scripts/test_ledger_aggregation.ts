#!/usr/bin/env ts-node
import ledgerAggregator from '../src/ledgerWindowAggregator';
import { LEDGER_BIT_BASE_SHIFT, BIT_SOLLET_CREATED, LEDGER_WEIGHTS_BY_INDEX } from '../src/ledgerWeights';

function mkMask(...offsets:number[]){
  let m = 0;
  for(const o of offsets) m |= (1 << (LEDGER_BIT_BASE_SHIFT + o));
  return m;
}

async function main(){
  console.log('Starting ledger aggregator live test');
  const mint = 'TESTMINT123';

  // Add sample: account created + lp struct
  ledgerAggregator.addSample(mint, { ledgerMask: mkMask(0,5), ledgerStrong: false, solletCreatedHere: false, sig: 'sig1' });
  // Add sample: same mint, sollet created here (different timestamp)
  ledgerAggregator.addSample(mint, { ledgerMask: 0, ledgerStrong: false, solletCreatedHere: true, sig: 'sig2' });
  // Add strong ledger sample
  ledgerAggregator.addSample(mint, { ledgerMask: mkMask(6), ledgerStrong: true, solletCreatedHere: false, sig: 'sig3' });

  // Wait a bit to ensure timestamps differ
  await new Promise(r=>setTimeout(r, 50));

  const agg = ledgerAggregator.getAggregated(mint, 10_000, 10_000);
  const score = ledgerAggregator.computeScoreFromWeights(agg.aggregatedMask, LEDGER_WEIGHTS_BY_INDEX);

  console.log('\n=== Aggregated Result ===');
  console.log('mint:', mint);
  console.log('count:', agg.count);
  console.log('aggregatedMask:', agg.aggregatedMask);
  console.log('aggregatedMask (binary):', (agg.aggregatedMask||0).toString(2));
  console.log('ledgerStrong:', agg.ledgerStrong);
  console.log('solletCreatedHere:', agg.solletCreatedHere);
  console.log('mergedSignal:', agg.mergedSignal);
  console.log('bitCounts (absolute index):', agg.bitCounts);
  console.log('firstTs:', agg.firstTs, 'lastTs:', agg.lastTs);
  console.log('computedScore:', score);

  // Show per-index interpretation
  console.log('\nInterpreted bits present:');
  for(const k of Object.keys(agg.bitCounts).map(x=>Number(x)).sort((a,b)=>a-b)){
    const idx = k;
    const offset = idx - LEDGER_BIT_BASE_SHIFT;
    console.log(`bitIndex=${idx} (offset=${offset}) count=${agg.bitCounts[k]}`);
  }
}

main().catch(e=>{ console.error('Test failed', e); process.exit(1); });
