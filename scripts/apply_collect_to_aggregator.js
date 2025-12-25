#!/usr/bin/env node
(async ()=>{
  try{
    const sniper = require('../sniper');
    const agg = require('../src/ledgerWindowAggregator').default;
    const lw = require('../src/ledgerWeights');
    const res = await sniper.collectFreshMints({ maxCollect: 1, timeoutMs: 60000 });
    if(!res || res.length === 0){ console.error('NO_MINT_COLLECTED'); process.exit(1); }
    const tok = res[0];
    const absMask = Number(tok.ledgerMask || 0);
    const base = Number(lw.LEDGER_BIT_BASE_SHIFT || 6);
    const rel = absMask >>> base;
    agg.addSample(tok.mint, { ledgerMask: rel, ledgerStrong: !!tok.ledgerStrong, solletCreatedHere: !!tok.solletCreatedHere, sig: tok.sourceSignature });
    const out = agg.getAggregated(tok.mint);
    const score = agg.computeScoreFromWeights(out.aggregatedMask, lw.LEDGER_WEIGHTS_BY_INDEX);
    console.log(JSON.stringify({ mint: tok.mint, signature: tok.sourceSignature, aggregated: out, score }, null, 2));
    process.exit(0);
  }catch(e){ console.error('ERR', e && e.stack||e); process.exit(2); }
})();
