#!/usr/bin/env ts-node
import SlotTracker from '../src/slotTracker';
import { LedgerDensity } from '../src/ledgerDensity';
import { detectSollet } from '../src/solletDetector';
const rpcPool = require('../src/utils/rpcPool');
const { LedgerSignalEngine } = require('../src/simulation/ledger_signal_engine');

async function main(){
  const tracker = new SlotTracker(800);
  const density = new LedgerDensity(6);
  const engine = new LedgerSignalEngine({ windowSlots: 5, densityThreshold: 2, requiredBits: 2 });

  tracker.on('slot', async (ev: any) => {
    const { slot, ts } = ev;
    const res = density.update(slot);
    console.log('[slot]', slot, 'densityCount=', res.densityCount, 'strong=', res.strong);

    // If density strong, attempt to fetch recent txs for sample signatures file and process them
    if(res.strong){
      try{
        const samplesPath = require('path').join(__dirname, 'raw_samples_only.json');
        if(require('fs').existsSync(samplesPath)){
          const samples = JSON.parse(require('fs').readFileSync(samplesPath,'utf8')) as any[];
          // pick up to 3 signatures to inspect
          for(const s of samples.slice(0,3)){
            const sig = s.signature || (s.rawFull && s.rawFull.signature);
            if(!sig) continue;
            const conn = rpcPool.getRpcConnection({ commitment: 'finalized' });
            try{
              const tx = await (conn as any).getParsedTransaction(sig, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }).catch(()=>null);
              const meta = (tx && tx.meta) || null;
              const isSollet = require('../src/solletDetector').detectSollet(tx && tx.transaction ? tx.transaction : tx, meta);
              console.log('Sample', s.mint, 'sig', sig, 'sollet=', isSollet, 'slot=', tx && tx.slot);
              // feed to engine for aggregation
              const ev2: any = { slot: tx && tx.slot ? tx.slot : slot, freshMints: [s.mint], sampleLogs: JSON.stringify(tx || {}), solletCreated: !!isSollet, transaction: tx && tx.transaction ? tx.transaction : null, meta };
              engine.processEvent(ev2);
            }catch(e){ /* ignore per-sample errors */ }
          }
        }
      }catch(e){ }

      if(res.strong){ console.log('Ledger density strong at slot', slot); }
    }
  });

  tracker.start();
  // run for short time
  setTimeout(()=>{ tracker.stop(); console.log('Stopped tracker'); process.exit(0); }, 10_000);
}

main().catch(e=>{ console.error(e); process.exit(1); });
