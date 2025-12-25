#!/usr/bin/env node
/**
 * Collect one mint (or accept JSON file), inject into FSM, check masks/ledger, then simulate buy and sell(50%).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sniper = require('../../sniper.js');
const sim = require('./sniper_simulator');
const { ProgramFSM } = require('./program_fsm_watcher');

async function collectOne(timeoutMs=120000){
  const res = await sniper.collectFreshMints({ maxCollect: 1, timeoutMs });
  if(Array.isArray(res) && res.length>0) return res[0];
  return null;
}

async function run(fileArg){
  try{
    let tok = null;
    if(fileArg && fileArg.endsWith('.json')){
      const j = path.resolve(fileArg);
      const data = JSON.parse(fs.readFileSync(j,'utf8'));
      tok = Array.isArray(data) ? data[0] : data;
      console.error('Using provided token JSON');
    }
    if(!tok){
      console.error('Collecting one fresh mint (timeout 120s)');
      tok = await collectOne(120000);
      if(!tok){ console.error('No mint collected'); process.exit(2); }
    }

    console.error('Collected token:', JSON.stringify(tok, null, 2));
    // save
    const outFile = '/tmp/collected_token_live.json';
    fs.writeFileSync(outFile, JSON.stringify(tok), 'utf8');
    console.error('Saved token to', outFile);

    // Inject into FSM and wait a bit for probes
    const p = new ProgramFSM({ programs: [] });
    p.on('state', s=>{ console.error('[FSM EVENT state]', JSON.stringify(s)); });
    p.on('trigger', t=>{ console.error('[FSM EVENT trigger]', JSON.stringify(t)); });

    const ev = { time: new Date().toISOString(), program: tok.sourceProgram||tok.program||null, signature: tok.sourceSignature||tok.signature||null, kind: tok.kind||'initialize', freshMints: [ tok.tokenAddress||tok.mint||tok.address ], sampleLogs: tok.sampleLogs||[], txBlock: tok.txBlock||tok.firstBlock||tok.raw&&tok.raw.txBlock||null };
    console.error('Emitting programEvent with txBlock:', ev.txBlock);
    sniper.notifier.emit('programEvent', ev);

    // wait for async probes to run
    // wait for async probes to run (increase slightly to allow final reprobes)
    await new Promise(r=>setTimeout(r, 2500));
    const mintAddr = ev.freshMints[0];
    const stateObj = p.states.get(mintAddr) || null;
    console.error('FSM state entry for mint:', JSON.stringify(stateObj, null, 2));

    // Check ledgerMask and decode bit names and timing metrics
    const ledgerMask = stateObj && stateObj.ledgerMask ? Number(stateObj.ledgerMask) : 0;
    const ledgerTs = stateObj && stateObj._ledgerTs ? stateObj._ledgerTs : null;
    const finalLatency = stateObj && stateObj._lastFinalReprobeLatency ? stateObj._lastFinalReprobeLatency : null;
    console.error('ledgerMask:', ledgerMask, 'ledgerTs:', ledgerTs, 'finalReprobeLatencyMs:', finalLatency);
    // decode bits to names (same mapping as FSM)
    const LEDGER_BIT_NAMES = {
      64: 'AccountCreated', // 1<<6
      128: 'ATACreated',
      256: 'SameAuthority',
      512: 'ProgramInit',
      1024: 'SlotDensity',
      2048: 'LPStruct',
      4096: 'CleanFunding',
      8192: 'SlotAligned',
      16384: 'CreatorExposed'
    };
    const names = [];
    for (const [bitVal, name] of Object.entries(LEDGER_BIT_NAMES)){
      try{ if(ledgerMask & Number(bitVal)) names.push(name); }catch(_e){}
    }
    console.error('Decoded ledgerMask names:', names.join(', ') || '(none)');

    // Now simulate forced buy (use run_live_sim_buy_force logic)
    const state = { token: tok.tokenAddress||tok.mint||tok.address, liquidity_usd: 15000, pool_initialized: true, is_transferable: true, mint_authority: false, freeze_authority: false, update_authority: false };
    console.error('Simulating FORCED BUY with LaunchState:', state);
    const exec = await (sim.pre_slot_analysis_with_liquidity ? sim.pre_slot_analysis_with_liquidity(state) : sim.pre_slot_analysis(state));
    console.error('Decision allowed for buy=', exec && exec.allowed);
    const clock = new sim.SlotClock(100000);
    await sim.slot_trigger(clock, clock.current_slot()+2, exec);

    // After buy, simulate sell 50% by creating a new state with reduced liquidity
    const sellState = Object.assign({}, state);
    sellState.liquidity_usd = Math.max(1, Math.floor(state.liquidity_usd * 0.5));
    console.error('Simulating SELL (50%) with LaunchState:', sellState);
    const execSell = await (sim.pre_slot_analysis_with_liquidity ? sim.pre_slot_analysis_with_liquidity(sellState) : sim.pre_slot_analysis(sellState));
    console.error('Decision allowed for sell=', execSell && execSell.allowed);
    const clock2 = new sim.SlotClock(200000);
    await sim.slot_trigger(clock2, clock2.current_slot()+2, execSell);

    console.error('Buy+Sell simulation complete.');

    // Simulate a fake user's immediate buy/sell log (no real RPC)
    try{
      const fakeUser = { id: 'test-user', username: 'testuser', strategy: { buyAmount: 0.05, sellAmount: 0.05 }, secret: 'FAKE-SECRET' };
      console.error('[SIM_FAKE_USER] Simulating immediate buy for user', fakeUser.id, 'token', state.token || mintAddr, 'amount', fakeUser.strategy.buyAmount);
      const simBuyResult = { tx: 'SIM_TX_BUY_FAKE', status: 'simulated', latencyMs: 5, ledgerMask, ledgerMaskNames: names, finalReprobeMs: finalLatency };
      console.error('[SIM_FAKE_USER] buy result:', JSON.stringify(simBuyResult));
      // Simulate immediate sell 50% afterwards
      console.error('[SIM_FAKE_USER] Simulating immediate sell (50%) for user', fakeUser.id);
      const simSellResult = { tx: 'SIM_TX_SELL_FAKE', status: 'simulated', latencyMs: 3, ledgerMask, ledgerMaskNames: names, finalReprobeMs: finalLatency };
      console.error('[SIM_FAKE_USER] sell result:', JSON.stringify(simSellResult));
    }catch(e){ console.error('Fake user simulation error', e); }
    process.exit(0);
  }catch(e){ console.error('run_buy_sell_flow error', e && e.stack || e); process.exit(1); }
}

const arg = process.argv[2] || null;
run(arg);
