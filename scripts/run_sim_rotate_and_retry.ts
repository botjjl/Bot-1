require('dotenv').config();
const { execSync } = require('child_process');
const rpcPool = require('../src/utils/rpcPool');

async function sleep(ms:any){ return new Promise(r=>setTimeout(r, ms)); }

async function main(){
  const iters = Number(process.env.SIM_ROTATE_ITERS || 5);
  const delayMs = Number(process.env.SIM_ROTATE_DELAY_MS || 1000);
  console.log('Running simulator with RPC rotation', 'iters=', iters, 'delayMs=', delayMs);
  for(let i=0;i<iters;i++){
    try{
      // pick next helius url if available
      let prefer = null;
      try{ prefer = (rpcPool.getNextHeliusRpcUrl && rpcPool.getNextHeliusRpcUrl()) || null; }catch(_e){}
      if(prefer) {
        console.log('Iteration', i+1, '-> using preferred Helius RPC:', prefer);
        process.env.HELIUS_RPC_URL = prefer;
        process.env.HELIUS_FAST_RPC_URL = prefer;
      } else {
        console.log('Iteration', i+1, '-> no helius rotation available, using static env');
      }
      // run the simulate-only script
      console.log('Spawning simulator process...');
      execSync('npx ts-node scripts/run_live_sim_one.ts', { stdio: 'inherit', env: process.env });
    }catch(e:any){
      try{ console.error('Iteration', i+1, 'failed:', e && e.message ? e.message : e); }catch(_){ console.error('Iteration', i+1, 'failed:', String(e)); }
    }
    if(i < iters-1) await sleep(delayMs);
  }
  console.log('All iterations complete');
}

main().catch(e=>{ console.error(e); process.exit(1); });
