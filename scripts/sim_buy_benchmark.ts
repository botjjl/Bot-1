require('dotenv').config();
// Benchmark simulated buy quotes on Jupiter vs Raydium for a token
import { createJupiterApiClient } from '@jup-ag/api';
const rpcPool = require('../src/utils/rpcPool').default;
// Prefer using the same Helius RPC that was used for live sends (or the fast RPC)
try{
  const prefer = process.env.HELIUS_FAST_RPC_URL || (rpcPool.getLastUsedUrl && rpcPool.getLastUsedUrl());
  if(prefer) process.env.HELIUS_RPC_URL = prefer;
}catch(e){}
const { getPriceInSOL } = require('../src/raydium/raydium.service');
const { checkLiquidityOnJupiter } = require('../src/simulation/liquidity');

async function bench(mint: string, amountSol = 0.005, runs = Number(process.env.SIM_BENCH_RUNS||20)){
  const delayMs = Number(process.env.SIM_BENCH_DELAY_MS || 300);
  const forceJupiter = String(process.env.FORCE_JUPITER || '').toLowerCase() === 'true';
  console.log('Benchmarking', mint, 'amountSol', amountSol, 'runs', runs, 'delayMs', delayMs, 'forceJupiter', forceJupiter);
  const jupiter = createJupiterApiClient();
  const results: any[] = [];
  const rpcPool = require('../src/utils/rpcPool').default;
  for(let i=0;i<runs;i++){
    const start = Date.now();
    let jQuote: any = null;
    try{
      const amt = Math.floor(amountSol * 1e9);
      // rotate helius url before each quote attempt to mitigate rate-limits
      try{ process.env.HELIUS_RPC_URL = (rpcPool.getNextHeliusRpcUrl && rpcPool.getNextHeliusRpcUrl()) || process.env.HELIUS_RPC_URL; }catch(_){ }
      jQuote = await jupiter.quoteGet({ inputMint: 'So11111111111111111111111111111111111111112', outputMint: mint, amount: amt, slippageBps: Number(process.env.JUPITER_SLIPPAGE_BPS||30) });
    }catch(e){
      // if error, attempt retry with alternative helius url(s)
      let errStr: string | null = String(e);
      let tried = 0;
      const candidates = (rpcPool.getHealthyCandidates && rpcPool.getHealthyCandidates()) || (rpcPool.getRpcCandidates && rpcPool.getRpcCandidates()) || [];
      for(const c of candidates){
        if(tried++ > 3) break;
        try{
          process.env.HELIUS_RPC_URL = c;
          const amt = Math.floor(amountSol * 1e9);
          jQuote = await jupiter.quoteGet({ inputMint: 'So11111111111111111111111111111111111111112', outputMint: mint, amount: amt, slippageBps: Number(process.env.JUPITER_SLIPPAGE_BPS||30) });
          errStr = null;
          break;
        }catch(re){ errStr = String(re); }
        await new Promise(r=>setTimeout(r, 200));
      }
      if(!jQuote) jQuote = { error: errStr || 'unknown' };
    }
    const jLatency = Date.now() - start;
    // Use the Raydium library price as primary source (user request)
    const rayStart = Date.now();
    let rPrice = 0;
    try{ rPrice = await getPriceInSOL(mint); }catch(e){ rPrice = 0; }
    const rLatency = Date.now() - rayStart;
    // estimate outAmount from library price if Jupiter quote missing
    let estOutFromLib = 0;
    try{ if(rPrice && rPrice > 0) estOutFromLib = Math.floor(amountSol / rPrice); }catch(e){ estOutFromLib = 0; }
    const liq = await checkLiquidityOnJupiter(mint, amountSol).catch(()=>({ tradable:false }));
    results.push({ jLatency, rLatency, jQuote, rPrice, liq });
    await new Promise(r=>setTimeout(r, delayMs));
  }
  // summarize
  const avg = (arr:number[])=>Math.round(arr.reduce((a,b)=>a+b,0)/arr.length);
  console.log('Jupiter avg latency ms', avg(results.map(r=>r.jLatency)));
  console.log('Raydium avg latency ms', avg(results.map(r=>r.rLatency)));
  // try to extract price/outAmount from jQuote
  const outAmounts = results.map(r=>{ try{ return Number(r.jQuote && (r.jQuote.outAmount || r.jQuote.routesInfos?.[0]?.outAmount || r.jQuote.routePlan?.[0]?.outAmount) || 0); }catch(e){ return 0; } });
  const nonZero = outAmounts.filter(x=>x>0);
  if(nonZero.length>0){
    const avgOut = Math.round(nonZero.reduce((a,b)=>a+b,0)/nonZero.length);
    console.log('Jupiter avg outAmount (base units)', avgOut);
  } else console.log('No valid outAmount from Jupiter quotes');
  // price impact summary
  const impacts = results.map(r=>r.liq && r.liq.priceImpact ? Number(r.liq.priceImpact) : null).filter(x=>x!==null) as number[];
  if(impacts.length>0) console.log('Jupiter avg reported priceImpact pct', (impacts.reduce((a,b)=>a+b,0)/impacts.length));
  console.log('Raw samples (first 3):', results.slice(0,3));
  // write full results
  try{
    const fs = require('fs');
    const outdir = 'tmp'; if(!fs.existsSync(outdir)) fs.mkdirSync(outdir);
    fs.writeFileSync(outdir + '/jupiter_bench.json', JSON.stringify({ meta: { mint, amountSol, runs, delayMs, forceJupiter }, results }, null, 2));
    console.log('Wrote full results to tmp/jupiter_bench.json');
  }catch(e){ console.warn('Failed writing results', e); }
}

(async()=>{
  const mint = process.env.TEST_MINT || '65QTjRqdiYaSHmohv4EEaiCgGFJpydjdxqyBrhorNw54';
  await bench(mint, Number(process.env.SIM_BENCH_AMOUNT || 0.005), Number(process.env.SIM_BENCH_RUNS || 10));
  process.exit(0);
})();
