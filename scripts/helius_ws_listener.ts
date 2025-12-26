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
      // Prefer env override, otherwise subscribe only to the canonical program list.
      const DEFAULT_PROGS = ['9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp','6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'];
      // Force using canonical program list only (ignore env overrides)
      const progs = DEFAULT_PROGS.slice();
      if(progs && progs.length){
        console.log('Subscribing to logs for canonical programs only:', progs);
        // Use 'processed' commitment to minimize latency (earliest practical signal)
        const sub = { jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [ { mentions: progs }, { commitment: 'processed', encoding: 'jsonParsed' } ] };
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

              // Local helpers: determine explicit kind and whether a mint was created in this tx
              const txKindLocal = (ttx:any) => {
                try{
                  const meta = ttx && (ttx.meta || (ttx.transaction && ttx.meta)) || {};
                  const logsAll = Array.isArray(meta.logMessages)? meta.logMessages.join('\n').toLowerCase() : '';
                  if(logsAll.includes('instruction: initializemint') || logsAll.includes('initialize mint') || logsAll.includes('instruction: initialize_mint')) return 'initialize';
                  if(logsAll.includes('createpool') || logsAll.includes('initializepool') || logsAll.includes('create pool')) return 'pool_creation';
                  if(logsAll.includes('instruction: swap') || logsAll.includes('\nprogram log: instruction: swap') || logsAll.includes(' swap ')) return 'swap';
                  const msg = ttx && (ttx.transaction && ttx.transaction.message) || ttx.transaction || {};
                  const instrs = (msg && msg.instructions) || [];
                  for(const ins of instrs){ try{ const t = (ins.parsed && ins.parsed.type) || (ins.type || ''); if(!t) continue; const lt = String(t).toLowerCase(); if(lt.includes('initializemint')||lt.includes('initialize_mint')||lt.includes('initialize mint')) return 'initialize'; if(lt.includes('createpool')||lt.includes('initializepool')||lt.includes('create pool')) return 'pool_creation'; if(lt.includes('swap')) return 'swap'; }catch(e){} }
                }catch(e){}
                return null;
              };
              const isMintCreatedInThisTxLocal = (ttx:any, mint:string) => {
                try{
                  if(!ttx) return false;
                  const logsAll = (ttx.logs || (ttx.value && ttx.value.logs) || []).join('\n').toLowerCase();
                  const m = String(mint).toLowerCase();
                  if(logsAll.includes('instruction: initializemint') || logsAll.includes('initialize mint') || logsAll.includes('initialize_mint') || logsAll.includes('createidempotent')) return true;
                  if(m && logsAll.includes(m)) return true;
                  const msg = ttx && (ttx.transaction && ttx.transaction.message) || ttx.transaction || {};
                  const instrs = (msg && msg.instructions) || [];
                  for(const ins of instrs){
                    try{
                      const t = (ins.parsed && ins.parsed.type) || (ins.type || '');
                      if(t && String(t).toLowerCase().includes('initializemint')) return true;
                      const info = ins.parsed && ins.parsed.info;
                      if(info){ if(info.mint && String(info.mint).toLowerCase() === m) return true; if(info.newAccount && String(info.newAccount).toLowerCase() === m) return true; }
                    }catch(e){}
                  }
                }catch(e){}
                return false;
              };

              const kind = txKindLocal(tx);
              // Filter to only mints that were created/initialized in this transaction
              const createdMints: string[] = [];
              for(const mint of mints){ try{ if(isMintCreatedInThisTxLocal(tx, mint)) createdMints.push(mint); }catch(_e){} }

              // Only add samples and feed engine when we detect an initialize or created mints
              if(kind === 'initialize' || (Array.isArray(createdMints) && createdMints.length>0)){
                const sigVal = signature || (res && res.value && res.value.signature) || null;
                for(const mint of createdMints){
                  const s: any = { ledgerMask: relMask, ledgerStrong: false, solletCreatedHere: !!isSollet, sig: sigVal };
                  try{ aggregator.addSample(mint, s); }catch(_e){}
                }
                const ev: any = { slot: slot || (tx.slot || 0), freshMints: createdMints, sampleLogs: logs.join('\n'), solletCreated: !!isSollet, transaction: tx.transaction || null, meta: tx.meta || null };
                  try{ engine.processEvent(ev); }catch(_e){}

                // FAST MASK-BASED EXECUTION PATH (no additional on-chain metadata required)
                try{
                  const ENABLE_FAST_MASK_EXEC = (process.env.ENABLE_FAST_MASK_EXEC === 'true');
                  if(ENABLE_FAST_MASK_EXEC){
                    // Determine required mask bits/count from env
                    const REQ_MASK_BITS = (process.env.MASK_REQUIRED_BITS || '').toString().split(',').map(s=>s.trim()).filter(Boolean).map(Number).filter(n=>!Number.isNaN(n));
                    const REQ_MASK_MIN_COUNT = Number(process.env.MASK_REQUIRED_MIN_COUNT || 2);
                    // For each created mint, check ledger mask and strength
                    for(const mm of createdMints){
                      try{
                        const slotNum = slot || (tx && tx.slot) || null;
                        const mask = engine.getMaskForMint(mm, slotNum);
                        const strong = engine.isStrongSignal(mm, slotNum);
                        // compute bit match count
                        let matchCount = 0;
                        if(Array.isArray(REQ_MASK_BITS) && REQ_MASK_BITS.length>0){
                          for(const b of REQ_MASK_BITS){ if(mask & (1<<b)) matchCount++; }
                        } else {
                          // fallback: count non-zero bits in mask's interesting range (6-14)
                          for(let b=6;b<=14;b++) if(mask & (1<<b)) matchCount++;
                        }
                        const meets = (matchCount >= REQ_MASK_MIN_COUNT) && (!!strong || matchCount >= REQ_MASK_MIN_COUNT+1);
                        if(meets){
                          // Trigger immediate execution for confirmed users (same logic as below, but skip tx/meta fetch)
                          const AUTO_EXEC_CONFIRM_USER_IDS = (process.env.AUTO_EXEC_CONFIRM_USER_IDS || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
                          if(AUTO_EXEC_CONFIRM_USER_IDS.length>0){
                            const usersPath = require('path').join(process.cwd(), 'users.json');
                            let users = {};
                            try{ users = JSON.parse(require('fs').readFileSync(usersPath,'utf8')||'{}'); }catch(_e){ users = {}; }
                            const autoExecMod = require('../src/autoStrategyExecutor');
                            for(const uid of AUTO_EXEC_CONFIRM_USER_IDS){
                              try{
                                const user = users[uid];
                                if(!user) continue;
                                if(!(user && (user.secret || user.wallet))) continue;
                                const execTok = { mint: mm, tokenAddress: mm, address: mm, sampleLogs: logs.join('\n'), ledgerMask: mask, ledgerStrong: strong, __listenerCollected: true };
                                // run async and non-blocking; pass listenerBypass to prioritize immediate path
                                (async ()=>{
                                  try{ await autoExecMod.autoExecuteStrategyForUser(user, [execTok], 'buy', { listenerBypass: true, forceAllowSignal: true }); }
                                  catch(e){ try{ console.error('[helius_ws_listener:fastMaskExec] error', e && e.message || e); }catch(_){} }
                                })();
                              }catch(_e){}
                            }
                          }
                        }
                      }catch(_e){}
                    }
                  }
                }catch(_e){}
              }

              // Optional: immediate auto-exec hook for confirmed users
              try{
                const AUTO_EXEC_ENABLED = (process.env.ENABLE_AUTO_EXEC_FROM_LISTENER === 'true');
                const AUTO_EXEC_CONFIRM_USER_IDS = (process.env.AUTO_EXEC_CONFIRM_USER_IDS || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
                if(AUTO_EXEC_ENABLED && AUTO_EXEC_CONFIRM_USER_IDS.length>0){
                  try{
                    const usersPath = require('path').join(process.cwd(), 'users.json');
                    let users = {};
                    try{ users = JSON.parse(require('fs').readFileSync(usersPath,'utf8')||'{}'); }catch(_e){ users = {}; }
                    const autoExecMod = require('../src/autoStrategyExecutor');
                    for(const uid of AUTO_EXEC_CONFIRM_USER_IDS){
                      try{
                        const user = users[uid];
                        if(!user) continue;
                        // require credentials present
                        if(!(user && (user.secret || user.wallet))) continue;
                        // Only consider created mints (or any when explicit initialize)
                        if(!(kind === 'initialize' || (Array.isArray(createdMints) && createdMints.length>0))) continue;
                        // build lightweight token objects for immediate execution
                        const execTokens = (createdMints || []).map((mm:string)=>{
                          const tok:any = { mint: mm, tokenAddress: mm, address: mm, sampleLogs: logs.join('\n') };
                          try{ tok.ledgerMask = engine.getMaskForMint(mm, slot || (tx && tx.slot) || null); }catch(_e){}
                          try{ tok.ledgerStrong = engine.isStrongSignal(mm, slot || (tx && tx.slot) || null); }catch(_e){}
                          return tok;
                        });
                        // run in background, listenerBypass to favor immediate execution
                        (async ()=>{
                          try{ await autoExecMod.autoExecuteStrategyForUser(user, execTokens, 'buy', { listenerBypass: true, forceAllowSignal: true }); }
                          catch(e){ try{ console.error('[helius_ws_listener:autoExec] error', e && e.message || e); }catch(_){} }
                        })();
                      }catch(_e){}
                    }
                  }catch(_e){}
                }
              }catch(_e){}
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
