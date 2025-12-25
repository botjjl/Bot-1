#!/usr/bin/env ts-node
// Simple Helius WebSocket listener template. Install `ws` to use: `npm install ws`
// Ensure .env is loaded so HELIUS_* env vars are available
try{ require('dotenv').config(); }catch(e){}
const WsLib: any = require('ws');
let heliusSdk: any = null;
try{ heliusSdk = require('helius-sdk'); }catch(e){ heliusSdk = null; }
const rpcPool = require('../src/utils/rpcPool');
const { LedgerSignalEngine } = require('../src/simulation/ledger_signal_engine');
const detectSollet = require('../src/solletDetector').default || require('../src/solletDetector');

async function main(){
  let wsUrl = (rpcPool.getNextHeliusWsUrl && rpcPool.getNextHeliusWsUrl()) || null;
  // ensure ws scheme: if rpcPool returned an https URL, coerce to wss
  try{
    if(wsUrl && wsUrl.startsWith('http:')) wsUrl = wsUrl.replace(/^http:/i, 'ws:');
    if(wsUrl && wsUrl.startsWith('https:')) wsUrl = wsUrl.replace(/^https:/i, 'wss:');
  }catch(e){}
  if(!wsUrl){ console.error('No Helius WS URL available'); process.exit(1); }
  console.log('Connecting to Helius WS', wsUrl);
  const ws: any = new WsLib(wsUrl);
  const engine = new LedgerSignalEngine({ windowSlots: 5, densityThreshold: 2, requiredBits: 2 });

  ws.on('open', () => {
    console.log('WS open');
    // subscribe to logs. Prefer restricting by program ids when provided in env
    try{
      const progs = (process.env.KNOWN_AMM_PROGRAM_IDS || process.env.PROGRAMS || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
      if(progs && progs.length){
        console.log('Subscribing to logs mentioning programs:', progs);
        const sub = { jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [ { mentions: progs }, { commitment: 'finalized', encoding: 'jsonParsed' } ] };
        ws.send(JSON.stringify(sub));
      } else {
        console.log('No program filter provided; subscribing to all logs');
        const sub = { jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [ { mentions: [] }, { commitment: 'finalized', encoding: 'jsonParsed' } ] };
        ws.send(JSON.stringify(sub));
      }
    }catch(e){ console.error('WS subscribe send failed', e); }
  });

  ws.on('message', (data: any) => {
    try{
      const msg = JSON.parse(String(data));
      if(msg.method && msg.method === 'logsNotification' && msg.params && msg.params.result){
        const res = msg.params.result;
        // res contains logs + signature + err + slot
        const signature = res.signature || (res.value && res.value.signature) || null;
        const slot = res.slot || (res.value && res.value.slot) || null;
        const logs = res.logs || (res.value && res.value.logs) || [];
        console.log('WS logs for sig', signature, 'slot', slot);
        // Attempt to fetch full tx via REST and process
        (async ()=>{
          try{
            if(!signature) return;
            // try helius-sdk first
            let tx: any = null;
            try{
              if(heliusSdk){
                let client: any = null;
                if(typeof heliusSdk === 'function') client = heliusSdk(process.env.HELIUS_API_KEY || '');
                else if(heliusSdk && typeof heliusSdk.Helius === 'function') client = heliusSdk.Helius(process.env.HELIUS_API_KEY || '');
                else if(heliusSdk && heliusSdk.default && typeof heliusSdk.default === 'function') client = heliusSdk.default(process.env.HELIUS_API_KEY || '');
                if(client && typeof client.getTransaction === 'function'){
                  tx = await client.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
                }
              }
            }catch(e){ tx = null; }
            if(!tx){
              const hel = (rpcPool.getNextHeliusRpcUrl && rpcPool.getNextHeliusRpcUrl()) || null;
              if(!hel) return;
              const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] });
              const resp = await (typeof fetch === 'function' ? fetch(hel, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }) : require('axios').post(hel, body, { headers: { 'Content-Type': 'application/json' } }));
              const data = typeof resp.json === 'function' ? await resp.json() : resp.data;
              tx = data && data.result ? data.result : null;
            }
            if(tx){
              const isSollet = detectSollet(tx.transaction || tx, tx.meta || tx);
              // attempt to derive mint(s) from token balances
              const meta = tx.meta || tx;
              const post = meta && meta.postTokenBalances ? meta.postTokenBalances : [];
              const pre = meta && meta.preTokenBalances ? meta.preTokenBalances : [];
              const mintsSet = new Set<string>();
              for(const p of post) if(p && p.mint) mintsSet.add(p.mint);
              for(const p of pre) if(p && p.mint) mintsSet.add(p.mint);
              const mints = Array.from(mintsSet);

              // derive purchase deltas per owner
              const ownerDeltas: Record<string, number> = {};
              let maxDelta = 0;
              for(const p of post){
                try{
                  const preEntry = (pre || []).find((x:any)=>x.accountIndex===p.accountIndex || (x.pubkey && x.pubkey===p.pubkey) || (x.owner && x.owner===p.owner));
                  const postAmt = p.uiTokenAmount && p.uiTokenAmount.uiAmount ? Number(p.uiTokenAmount.uiAmount) : 0;
                  const preAmt = preEntry && preEntry.uiTokenAmount && preEntry.uiTokenAmount.uiAmount ? Number(preEntry.uiTokenAmount.uiAmount) : 0;
                  const delta = Math.max(0, postAmt - preAmt);
                  if(delta>0){ ownerDeltas[p.owner || p.pubkey || ('a'+Math.random())] = (ownerDeltas[p.owner||p.pubkey]||0) + delta; maxDelta = Math.max(maxDelta, delta); }
                }catch(e){ }
              }

              // build a relative ledgerMask (LSB maps to base shift in aggregator)
              const lw = require('../src/ledgerWeights');
              const base = lw.LEDGER_BIT_BASE_SHIFT || 6;
              let relMask = 0;
              // helper to set relative bit by absolute index
              const setRelByAbs = (absIdx:number)=>{ const rel = absIdx - base; if(rel>=0) relMask |= (1<<rel); };

              // swap detection via instruction program ids heuristics
              try{
                const instrs = (tx.transaction && tx.transaction.message && tx.transaction.message.instructions) || (tx.message && tx.message.instructions) || [];
                for(const ix of instrs){
                  const pid = ix.programIdString || ix.programId || ix.program || '';
                  const pidStr = String(pid).toLowerCase();
                  if(pidStr.includes('swap') || pidStr.includes('raydium') || pidStr.includes('jupiter') || pidStr.includes('amm') || pidStr.includes('serum') || pidStr.includes('token-swap')){
                    setRelByAbs(Math.log2(lw.BIT_SWAP_DETECTED));
                    break;
                  }
                }
              }catch(e){ }

              // liquidity / wsol heuristics
              try{
                const logsArr = (tx.logs || tx.value && tx.value.logs) || [];
                const logsStr = Array.isArray(logsArr) ? logsArr.join('\n').toLowerCase() : String(logsArr).toLowerCase();
                if(logsStr.includes('liquidity') || logsStr.includes('add') && logsStr.includes('liquidity')) setRelByAbs(Math.log2(lw.BIT_LIQUIDITY_ADDED));
                if(logsStr.includes('wrap') && logsStr.includes('sol')) setRelByAbs(Math.log2(lw.BIT_WSOL_INTERACTION));
              }catch(e){ }

              // buyer counts and first-buy flags per mint
              const uniqueBuyers = Object.keys(ownerDeltas).length;
              if(uniqueBuyers>=2) setRelByAbs(Math.log2(lw.BIT_MULTI_BUYERS));
              // size bins thresholds (env override)
              const smallTh = Number(process.env.BUY_SMALL_THRESHOLD || 1);
              const medTh = Number(process.env.BUY_MEDIUM_THRESHOLD || 10);
              if(maxDelta>0){
                if(maxDelta < smallTh) setRelByAbs(Math.log2(lw.BIT_FIRST_BUY_SMALL));
                else if(maxDelta < medTh) setRelByAbs(Math.log2(lw.BIT_FIRST_BUY_MEDIUM));
                else setRelByAbs(Math.log2(lw.BIT_FIRST_BUY_LARGE));
                setRelByAbs(Math.log2(lw.BIT_FIRST_BUY));
              }

              // high fee detection
              try{ const fee = (meta && meta.fee) || (meta && meta.feePayer) || 0; if(fee>0) setRelByAbs(Math.log2(lw.BIT_HIGH_FEE)); }catch(e){}

              // for each mint, emit aggregator sample
              const aggregator = require('../src/ledgerWindowAggregator').default;
              for(const mint of mints){
                const sigVal = signature || (res && res.value && res.value.signature) || null;
                const s: any = { ledgerMask: relMask, ledgerStrong: false, solletCreatedHere: !!isSollet, sig: sigVal };
                aggregator.addSample(mint, s);
              }

              // also feed engine for demonstration
              const ev: any = { slot: slot || (tx.slot || 0), freshMints: mints, sampleLogs: logs.join('\n'), solletCreated: !!isSollet, transaction: tx.transaction || null, meta: tx.meta || null };
              engine.processEvent(ev);
            }
          }catch(e){ /* ignore */ }
        })();
      }
    }catch(e){ /* ignore parse errors */ }
  });

  ws.on('close', () => { console.log('WS closed'); process.exit(0); });
  ws.on('error', (e:any) => { console.error('WS error', e); });
}

main().catch(e=>{ console.error(e); process.exit(1); });
