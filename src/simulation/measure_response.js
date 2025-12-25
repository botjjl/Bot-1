#!/usr/bin/env node
require('dotenv').config();
const sniper = require('../../sniper.js');
const { ProgramFSM } = require('./program_fsm_watcher');

async function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function measureCycles(cycles = 5, timeoutMs = 5000){
  const p = new ProgramFSM({ programs: [] });
  const results = [];
  for(let i=0;i<cycles;i++){
    try{
      const t0 = Date.now();
      console.error(`\n--- Cycle ${i+1}/${cycles} ---`);
      const collected = await sniper.collectFreshMints({ maxCollect:1, timeoutMs: 30000 });
      if(!Array.isArray(collected) || collected.length===0){ console.error('No mint collected in cycle', i+1); results.push({ collected: false }); continue; }
      const tok = collected[0];
      const mint = tok.tokenAddress || tok.mint || tok.address;
      console.error('Collected mint:', mint);
      const ev = { time: new Date().toISOString(), program: tok.sourceProgram||tok.program||null, signature: tok.sourceSignature||tok.signature||null, kind: tok.kind||'initialize', freshMints: [mint], sampleLogs: tok.sampleLogs||[], txBlock: tok.txBlock||tok.firstBlock||null };
      const emitTs = Date.now();
      sniper.notifier.emit('programEvent', ev);
      // wait until FSM populates state with ledgerMask or until timeout
      const stopAt = Date.now() + timeoutMs;
      let found = false; let stateObj = null; let seenMask = 0; let seenAt = null;
      while(Date.now() < stopAt){
        stateObj = p.states.get(mint) || null;
        if(stateObj && (typeof stateObj.ledgerMask !== 'undefined') && stateObj.ledgerMask){
          found = true; seenMask = Number(stateObj.ledgerMask); seenAt = Date.now(); break;
        }
        await sleep(100);
      }
      const latency = found ? (seenAt - emitTs) : null;
      console.error('Cycle result: found=', found, 'mask=', seenMask, 'latencyMs=', latency);
      results.push({ collected:true, mint, found, mask: seenMask, latencyMs: latency, state: stateObj });
    }catch(e){ console.error('Cycle error', e); results.push({ error: String(e) }); }
    await sleep(300);
  }
  // summarize
  const latencies = results.filter(r=>r && r.latencyMs!=null).map(r=>r.latencyMs);
  const avg = latencies.length ? Math.round(latencies.reduce((a,b)=>a+b,0)/latencies.length) : null;
  console.error('\n=== Summary ===');
  console.error('cycles:', cycles, 'successful masks:', latencies.length, 'avgLatencyMs:', avg);
  console.error('Detailed results:', JSON.stringify(results, null, 2));
  return results;
}

if(require.main === module){
  const cycles = Number(process.argv[2] || process.env.MEASURE_CYCLES || 5);
  measureCycles(cycles, Number(process.env.MEASURE_TIMEOUT_MS || 5000)).then(()=> process.exit(0)).catch(e=>{ console.error('measure error', e); process.exit(1); });
}

module.exports = { measureCycles };
