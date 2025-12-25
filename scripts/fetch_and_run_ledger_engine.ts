#!/usr/bin/env ts-node
// Load .env early so HELIUS_* and RPC env vars are available
try{ require('dotenv').config(); }catch(e){}
import fs from 'fs';
import path from 'path';
import rpcPool = require('../src/utils/rpcPool');
import { PublicKey } from '@solana/web3.js';
const { LedgerSignalEngine } = require('../src/simulation/ledger_signal_engine');
import { LEDGER_WEIGHTS_BY_BIT } from '../src/ledgerWeights';

// optional helius-sdk
let heliusSdk: any = null;
try{ heliusSdk = require('helius-sdk'); }catch(e){ heliusSdk = null; }

const liquidity = (() => { try{ return require('../src/simulation/liquidity'); }catch(e){ return null; } })();

async function countHoldersForMint(mint: string){
  try{
    const conn = rpcPool.getRpcConnection({ commitment: 'finalized' }) as any;
    const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const resp = await conn.getParsedProgramAccounts(TOKEN_PROGRAM, { filters: [ { memcmp: { offset: 0, bytes: mint } }, { dataSize: 165 } ] });
    if(!resp || !Array.isArray(resp)) return 0;
    let count = 0;
    for(const acc of resp){
      try{
        const info = acc.account && acc.account.data && acc.account.data.parsed && acc.account.data.parsed.info;
        const amt = info && info.tokenAmount && (typeof info.tokenAmount.uiAmount === 'number') ? Number(info.tokenAmount.uiAmount) : 0;
        if(amt && amt > 0) count++;
      }catch(e){}
    }
    return count;
  }catch(e){ return -1; }
}

async function estimateLiquidityForMint(mint: string){
  try{
    if(!liquidity || typeof liquidity.checkLiquidityOnJupiter !== 'function') return { tradable: false, note: 'no-liquidity-lib' };
    return await liquidity.checkLiquidityOnJupiter(mint, 1);
  }catch(e){ return { tradable: false, note: String(e) }; }
}

async function getApproxCreationTime(mint: string){
  try{
    const conn = rpcPool.getRpcConnection({ commitment: 'finalized' }) as any;
    const sigs = await conn.getSignaturesForAddress(new PublicKey(mint), { limit: 1000 });
    if(!sigs || sigs.length===0) return null;
    const last = sigs[sigs.length-1];
    return last && last.blockTime ? new Date(last.blockTime * 1000).toISOString() : null;
  }catch(e){ return null; }
}

async function sleep(ms: number){ return new Promise(r => setTimeout(r, ms)); }

async function fetchTxForSignature(sig: string){
  // prefer helius-sdk when available, then fall back to RPC connection, then REST helius endpoint
  try{
    if(heliusSdk){
      try{
        let client: any = null;
        if(typeof heliusSdk === 'function') client = heliusSdk(process.env.HELIUS_API_KEY || '');
        else if(heliusSdk && typeof heliusSdk.Helius === 'function') client = heliusSdk.Helius(process.env.HELIUS_API_KEY || '');
        else if(heliusSdk && heliusSdk.default && typeof heliusSdk.default === 'function') client = heliusSdk.default(process.env.HELIUS_API_KEY || '');
        if(client && typeof client.getTransaction === 'function'){
          const tx = await client.getTransaction(sig, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
          if(tx){ if(rpcPool.markSuccess) rpcPool.markSuccess('helius-sdk'); return { tx, url: 'helius-sdk' }; }
        }
      }catch(e){ /* fallthrough to RPC */ }
    }
  }catch(_e){}

  let backoff = 300;
  for(let attempt=0; attempt<6; attempt++){
    const conn = rpcPool.getRpcConnection({ commitment: 'finalized' }) as any;
    const url = (rpcPool.getLastUsedUrl && rpcPool.getLastUsedUrl()) || null;
    try{
      const tx = await (conn as any).getParsedTransaction(sig, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
      if(tx){ if(url && rpcPool.markSuccess) rpcPool.markSuccess(url); return { tx, url }; }
    }catch(e:any){ if(url && rpcPool.markFailureWithReason) rpcPool.markFailureWithReason(url, String(e && e.message ? e.message : e)); }

    // try helius REST endpoint as fallback
    try{
      const hel = (rpcPool.getNextHeliusRpcUrl && rpcPool.getNextHeliusRpcUrl()) || null;
      if(hel){
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] });
        const resp = await (typeof fetch === 'function' ? fetch(hel, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }) : require('axios').post(hel, body, { headers: { 'Content-Type': 'application/json' } }));
        const data = typeof resp.json === 'function' ? await resp.json() : resp.data;
        const tx = data && data.result ? data.result : null;
        if(tx){ if(rpcPool.markSuccess) rpcPool.markSuccess(hel); return { tx, url: hel }; }
      }
    }catch(_e){}

    await sleep(backoff);
    backoff = Math.min(2000, backoff * 1.8);
  }
  return { tx: null, url: null };
}

async function fetchTxForMint(mint: string){
  // fallback: find a recent signature touching the mint
  try{
    const conn = rpcPool.getRpcConnection({ commitment: 'finalized' });
    const sigs = await (conn as any).getSignaturesForAddress(new PublicKey(mint), { limit: 3 });
    if(sigs && sigs.length){
      for(const s of sigs){
        const r = await fetchTxForSignature(s.signature);
        if(r.tx) return r;
      }
    }
  }catch(e){ /* ignore */ }
  return { tx: null, url: null };
}

// Prefer transactions that invoke a given program id if provided.
async function fetchTxForMintWithProgram(mint: string, programId?: string){
  try{
    const conn = rpcPool.getRpcConnection({ commitment: 'finalized' }) as any;
    const sigs = await conn.getSignaturesForAddress(new PublicKey(mint), { limit: 20 });
    if(!sigs || sigs.length===0) return { tx: null, url: null };
    for(const s of sigs){
      const r = await fetchTxForSignature(s.signature);
      if(!r || !r.tx) continue;
      // if program filter is set, ensure the fetched tx touches the program
      if(programId){
        try{
          const txObj = r.tx.transaction || r.tx;
          const instrs = (txObj && txObj.message && txObj.message.instructions) || (txObj && txObj.instructions) || [];
          let touches = false;
          for(const ix of instrs){
            const pid = ix.programIdString || ix.programId || ix.program || (ix.program && ix.program.toString && ix.program.toString());
            if(!pid) continue;
            if(String(pid).toLowerCase().includes(String(programId).toLowerCase())){ touches = true; break; }
          }
          if(!touches) continue; // skip non-program transactions
        }catch(_e){ /* ignore parse errors and continue */ }
      }
      return r;
    }
  }catch(e){}
  return { tx: null, url: null };
}

async function main(){
  const samplesPath = path.join(__dirname, 'raw_samples_only.json');
  if(!fs.existsSync(samplesPath)){ console.error('raw samples file missing:', samplesPath); process.exit(1); }
  const samples = JSON.parse(fs.readFileSync(samplesPath,'utf8')) as any[];

  console.log('Fetching full transactions for', samples.length, 'samples');
  // Only accept transactions that invoke one of these programs (immediate listener programs)
  const PROGRAMS = [
    '9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp',
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
  ];

  function txTouchesAnyProgram(tx:any, programs:string[]){
    try{
      const txObj = tx && (tx.transaction || tx);
      const instrs = (txObj && txObj.message && txObj.message.instructions) || (txObj && txObj.instructions) || [];
      for(const ix of instrs){
        const pid = ix.programIdString || ix.programId || ix.program || (ix.program && ix.program.toString && ix.program.toString());
        if(!pid) continue;
        for(const p of programs){ if(String(pid).toLowerCase().includes(String(p).toLowerCase())) return true; }
      }
      // also check meta.innerInstructions
      const meta = tx && (tx.meta || tx);
      const inner = (meta && meta.innerInstructions) || [];
      for(const block of inner){
        const arr = (block && block.instructions) || [];
        for(const ix of arr){
          const pid = ix.programId || ix.programIdString || ix.program;
          if(!pid) continue;
          for(const p of programs){ if(String(pid).toLowerCase().includes(String(p).toLowerCase())) return true; }
        }
      }
    }catch(e){}
    return false;
  }
  for(const s of samples){
    const sig = s.signature || (s.rawFull && s.rawFull.signature);
    let result: any = null;
    if(sig){
      result = await fetchTxForSignature(sig);
    }
    if(!result || !result.tx){
      // try by mint; prefer transactions that invoke the sample's program when program id is present
      result = await fetchTxForMintWithProgram(s.mint, s.program || (s.rawFull && s.rawFull.program) || null);
      if(!result || !result.tx){
        // final fallback: generic mint-based fetch
        result = await fetchTxForMint(s.mint);
      }
    }
    if(result && result.tx){
      // ensure the tx touches one of the allowed programs; if not, try per-program fetches
      if(!txTouchesAnyProgram(result.tx, PROGRAMS)){
        let found = null;
        for(const p of PROGRAMS){
          const r2 = await fetchTxForMintWithProgram(s.mint, p);
          if(r2 && r2.tx && txTouchesAnyProgram(r2.tx, PROGRAMS)){ found = r2; break; }
        }
        if(found) result = found; else {
          console.warn('Skipping tx for', s.mint, 'sig=', sig, '— does not invoke allowed programs');
          continue;
        }
      }
      const tx = result.tx;
      s.rawFull = s.rawFull || {};
      s.rawFull.transaction = tx.transaction || null;
      s.rawFull.meta = tx.meta || null;
      s.rawFull.slot = tx.slot || s.rawFull.slot || null;
      s.rawFull.blockTime = tx.blockTime || s.rawFull.blockTime || null;
      s.rawFull.fetchedFrom = result.url || null;
      // record accepted program if possible
      try{ s.rawFull.acceptedPrograms = s.rawFull.acceptedPrograms || []; const tp = PROGRAMS.filter(p=> txTouchesAnyProgram(result.tx, [p])); if(tp.length) s.rawFull.acceptedPrograms.push(...tp); }catch(e){}
      console.log('Fetched', s.mint, 'sig=', sig, 'slot=', s.rawFull.slot, 'from=', result.url);
    }else{
      console.warn('No tx found for', s.mint, 'sig=', sig);
    }
    await sleep(200);
  }

  const enrichedPath = path.join(__dirname, 'raw_samples_enriched_rpc.json');
  fs.writeFileSync(enrichedPath, JSON.stringify(samples, null, 2));
  console.log('Wrote enriched samples to', enrichedPath);

  // now run engine
  const engine = new LedgerSignalEngine({ windowSlots: 5, densityThreshold: 2, requiredBits: 2 });
  let slot = 1000000;
  for(const s of samples){
    slot += 1;
    const ev: any = { slot, freshMints: [s.mint], sampleLogs: JSON.stringify(s.rawFull || {}), solletCreated: !!s.solletCreatedHere, transaction: s.rawFull && s.rawFull.transaction ? s.rawFull.transaction : null, meta: s.rawFull && s.rawFull.meta ? s.rawFull.meta : null };
    engine.processEvent(ev);
  }

  const out: any[] = [];
  for(const s of samples){
    const m = s.mint;
    const mask = engine.getMaskForMint(m, null);
    let cnt = 0; let mm = mask; while(mm){ cnt += mm & 1; mm >>>= 1; }
    let score = 0; for(const k of Object.keys(LEDGER_WEIGHTS_BY_BIT)){ const bit = Number(k); if(mask & bit) score += LEDGER_WEIGHTS_BY_BIT[bit] || 0; }
    out.push({ mint: m, signature: s.signature, mask, bits: cnt, score, solletCreatedHere: !!s.solletCreatedHere, fetchedFrom: s.rawFull && s.rawFull.fetchedFrom });
  }

  const outPath = path.join(__dirname, 'raw_samples_with_masks.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('Wrote results to', outPath);
  console.log(JSON.stringify(out, null, 2));
}

main().catch(e => { console.error('Fatal error', e); process.exit(1); });
