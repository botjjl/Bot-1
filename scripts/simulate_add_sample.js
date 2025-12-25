#!/usr/bin/env node
(async ()=>{
  try{
    const agg = require('../src/ledgerWindowAggregator').default;
    const lw = require('../src/ledgerWeights');
    const mint = process.argv[2];
    if(!mint){ console.error('Usage: node simulate_add_sample.js <mint>'); process.exit(1); }
    const buyMask = (lw.BIT_FIRST_BUY_MEDIUM || 0) | (lw.BIT_FIRST_BUY || 0) | (lw.BIT_SWAP_DETECTED || 0) | (lw.BIT_SOLLET_CREATED || 0);
    // convert absolute bits into relative mask expected by aggregator
    const base = Number(lw.LEDGER_BIT_BASE_SHIFT || 6);
    const rel = buyMask >>> base;
    agg.addSample(mint, { ledgerMask: rel, ledgerStrong: true, solletCreatedHere: true, sig: 'sim-buy-1' });
    const out = agg.getAggregated(mint);
    const score = agg.computeScoreFromWeights(out.aggregatedMask, lw.LEDGER_WEIGHTS_BY_INDEX);
    console.log(JSON.stringify({ mint, addedRelMask: rel, aggregated: out, score }, null, 2));
    process.exit(0);
  }catch(e){ console.error('ERR', e && e.stack||e); process.exit(2); }
})();
