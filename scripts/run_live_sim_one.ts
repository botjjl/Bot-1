import 'dotenv/config';
const sniper = require('../sniper.js');
const { ProgramFSM } = require('../src/simulation/program_fsm_watcher');
import { autoExecuteStrategyForUser } from '../src/autoStrategyExecutor';
const sim = require('../src/simulation/sniper_simulator');
import { Keypair } from '@solana/web3.js';

async function sleep(ms: number){ return new Promise(res=>setTimeout(res, ms)); }

async function main(){
  console.error('Collecting one fresh mint (timeout 60s)');
  const collected = await sniper.collectFreshMints({ maxCollect: 1, timeoutMs: 60000 });
  if(!Array.isArray(collected) || collected.length===0){ console.error('No mint collected'); process.exit(2); }
  const tok = collected[0];
  const mint = tok.tokenAddress || tok.mint || tok.address;
  console.error('Collected mint:', mint);

  // create a ProgramFSM to get ledgerMask
  const p = new ProgramFSM({ programs: [] });
  const ev = { time: new Date().toISOString(), program: tok.sourceProgram||tok.program||null, signature: tok.sourceSignature||tok.signature||null, kind: tok.kind||'initialize', freshMints: [mint], sampleLogs: tok.sampleLogs||[], txBlock: tok.txBlock||tok.firstBlock||null };
  const emitTs = Date.now();
  sniper.notifier.emit('programEvent', ev);

  // wait up to 5s for ledgerMask
  const stopAt = Date.now() + 5000;
  let stateObj = null;
  while(Date.now() < stopAt){
    stateObj = p.states.get(mint) || null;
    if(stateObj && typeof stateObj.ledgerMask !== 'undefined' && stateObj.ledgerMask) break;
    await sleep(100);
  }
  const ledgerMask = stateObj && stateObj.ledgerMask ? Number(stateObj.ledgerMask) : 0;
  console.error('Obtained ledgerMask:', ledgerMask);

  // prepare fake user with generated keypair (base64)
  const kp = Keypair.generate();
  // use tiny buyAmount to avoid SOL requirements for simulation
  const fakeUser: any = { id: 'fake-user-1', username: 'fakeuser', strategy: { buyAmount: 0.001, sellAmount: 0.001, enabled: true }, secret: Buffer.from(kp.secretKey).toString('base64') };

  // prepare token object for autoExecute: include mergedSignal if ledgerMask present or sollet hint
  const mergedSignal = Boolean(ledgerMask) || Boolean(ev && ev.sampleLogs && ev.sampleLogs.join('\n').toLowerCase().includes('initializemint'));
  const tokenObj = { mint, ledgerMask, mergedSignal };

  // simulate-only path: use local simulator to ensure buy+sell succeed without RPC or keys
  try{
    console.error('SIMULATE_ONLY: running local pre-slot analysis for BUY');
    const stateBuy = { token: mint, liquidity_usd: 15000, pool_initialized: true, is_transferable: true, mint_authority: false, freeze_authority: false, update_authority: false };
    const execBuy = sim.pre_slot_analysis_with_liquidity ? await sim.pre_slot_analysis_with_liquidity(stateBuy) : sim.pre_slot_analysis(stateBuy);
    try{ execBuy.trigger(); console.error('SIMULATED BUY: EXECUTION TRIGGERED'); }catch(e){ console.error('SIMULATED BUY: trigger error', e); }

    console.error('SIMULATE_ONLY: running local pre-slot analysis for SELL (50%)');
    const stateSell = Object.assign({}, stateBuy, { liquidity_usd: Math.max(1, Math.floor(stateBuy.liquidity_usd * 0.5)) });
    const execSell = sim.pre_slot_analysis_with_liquidity ? await sim.pre_slot_analysis_with_liquidity(stateSell) : sim.pre_slot_analysis(stateSell);
    try{ execSell.trigger(); console.error('SIMULATED SELL: EXECUTION TRIGGERED'); }catch(e){ console.error('SIMULATED SELL: trigger error', e); }
  }catch(e){
    console.error('SIMULATE_ONLY local simulation error', e);
  }
}

main().catch(e=>{ console.error('run_live_sim_one error', e); process.exit(1); });
