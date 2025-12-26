#!/usr/bin/env node
/**
 * ProgramMonitor: subscribes to sniper.js notifier events and emits predictions
 * - Collects per-program stats
 * - Runs simple heuristics to predict next tx kind
 */
const EventEmitter = require('events');
const axios = require('axios');
const { createJupiterApiClient } = require('@jup-ag/api');
const sniper = require('../../sniper.js');

// Minimal Helius RPC helper using env keys (fallback to public RPC)
const _HELIUS_KEYS = (process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
const HELIUS_RPC_URLS = (process.env.HELIUS_RPC_URLS || process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
if(HELIUS_RPC_URLS.length===0) HELIUS_RPC_URLS.push('https://mainnet.helius-rpc.com/');
let heliusCallCounter = 0;

async function heliusRpc(method, params){
  const keyIdx = heliusCallCounter % Math.max(1, _HELIUS_KEYS.length);
  const urlIdx = heliusCallCounter % Math.max(1, HELIUS_RPC_URLS.length);
  heliusCallCounter = (heliusCallCounter + 1) >>> 0;
  const url = HELIUS_RPC_URLS[urlIdx];
  const headers = Object.assign({'Content-Type':'application/json'}, _HELIUS_KEYS[keyIdx] ? { 'x-api-key': _HELIUS_KEYS[keyIdx] } : {});
  try{
    const res = await axios.post(url, { jsonrpc:'2.0', id:1, method, params }, { headers, timeout: 8000 });
    return res.data && (res.data.result || res.data);
  }catch(e){ return { __error: e.message || String(e) } }
}

// Simple first-signature cache to avoid hammering
const FIRST_SIG_CACHE = new Map();
async function getFirstSignatureCached(mint){
  if(!mint) return null;
  const now = Date.now();
  const cached = FIRST_SIG_CACHE.get(mint);
  if(cached && (now - cached.ts) < (15_000)) return cached.val;
  try{
    const sigs = await heliusRpc('getSignaturesForAddress', [mint, { limit: 1 }]);
    if(Array.isArray(sigs) && sigs.length>0){
      const e = sigs[0];
      const sig = e.signature || e.sig || e.txHash || null;
      const bt = e.blockTime || e.block_time || e.blocktime || null;
      const slot = e.slot || e.slotIndex || null;
      const val = { sig, blockTime: bt || null, slot: slot || null };
      FIRST_SIG_CACHE.set(mint, { ts: now, val });
      return val;
    }
    FIRST_SIG_CACHE.set(mint, { ts: now, val: null }); return null;
  }catch(e){ FIRST_SIG_CACHE.set(mint, { ts: now, val: null }); return null; }
}

// Prefer slot comparison when available, fallback to blockTime. Returns true/false/null
async function mintPreviouslySeen(mint, txSlot, txBlockTime, currentSig){
  if(!mint) return true;
  try{
    const sigs = await heliusRpc('getSignaturesForAddress', [mint, { limit: 8 }]);
    if(!Array.isArray(sigs) || sigs.length===0) return false;
    for(const s of sigs){
      try{
        const sig = s.signature || s.sig || s.txHash || null;
        const sSlot = s.slot || s.blockSlot || null;
        const bt = s.blockTime || s.block_time || s.blocktime || null;
        if(sig && sig !== currentSig && sSlot && txSlot && Number(sSlot) < Number(txSlot)) return true;
        if(sig && sig !== currentSig && bt && txBlockTime && Number(bt) < Number(txBlockTime)) return true;
      }catch(e){}
    }
    return false;
  }catch(e){ return null; }
}

class ProgramMonitor extends EventEmitter {
  constructor(opts = {}){
    super();
    this.windowMs = opts.windowMs || 30_000; // sliding window
    this.maxHistory = opts.maxHistory || 10;
    this.programs = new Map();
    this.mintObservations = new Map(); // mint -> [{ slot, ts, kind, sampleLogs, raw }]
    this._onProgramEvent = this._onProgramEvent.bind(this);
    if(sniper && sniper.notifier && typeof sniper.notifier.on === 'function'){
      sniper.notifier.on('programEvent', this._onProgramEvent);
      sniper.notifier.on('notification', this._onProgramEvent);
    }
  }

  _now(){ return Date.now(); }

  async _onProgramEvent(ev){
    try{
      const p = ev && ev.program ? ev.program : (ev && ev.event && ev.event.program) || 'unknown';
      const kind = ev && ev.kind ? ev.kind : (ev && ev.event && ev.event.kind) || 'unknown';
      const now = this._now();
      if(!this.programs.has(p)) this.programs.set(p, { events: [], counts: {}, lastSeen: 0 });
      const meta = this.programs.get(p);
      meta.events.push({ ts: now, kind, raw: ev });
      meta.lastSeen = now;
      meta.counts[kind] = (meta.counts[kind]||0) + 1;
      if(meta.events.length > this.maxHistory) meta.events.shift();

      // Track per-mint observations (slot-aware)
      try{
        const fresh = Array.isArray(ev.freshMints) ? ev.freshMints.slice(0,8) : [];
        for(const m of fresh){
          try{
            const first = await getFirstSignatureCached(m).catch(()=>null);
            const obsSlot = (first && first.slot) ? first.slot : (ev && (ev.slot || ev.blockSlot || ev.blockNumber) || null);
            const sampleLogs = (ev && ev.sampleLogs && Array.isArray(ev.sampleLogs)) ? ev.sampleLogs.join('\n').toLowerCase() : '';
            const entry = { slot: obsSlot, ts: now, kind: kind, sampleLogs, raw: ev };
            if(!this.mintObservations.has(m)) this.mintObservations.set(m, []);
            const arr = this.mintObservations.get(m);
            arr.push(entry);
            if(arr.length > 6) arr.shift();

            // detect Slot N-1 -> N pattern: previous slot contains mint creation + authority set + pool account uninitialized
            // and current slot contains pool initialization (heuristic via kind or logs)
            const isPoolInitKind = (kind && (kind === 'pool_creation' || kind === 'pool_initialized' || kind === 'initialize_pool' || (ev && (ev.sampleLogs||[]).join('').toLowerCase().includes('initialize pool'))));
            if(isPoolInitKind && obsSlot){
              const prevSlot = Number(obsSlot) - 1;
              const prev = arr.find(x => x.slot && Number(x.slot) === prevSlot);
              if(prev){
                const prevLogs = prev.sampleLogs || '';
                const hasCreate = prevLogs.includes('create') || prevLogs.includes('created') || prevLogs.includes('create account');
                const hasAuthority = prevLogs.includes('authority') || prevLogs.includes('setauthority') || prevLogs.includes('set authority');
                const hasPoolAccount = prevLogs.includes('pool') || prevLogs.includes('pool account') || prevLogs.includes('account');
                if(hasCreate && hasAuthority && hasPoolAccount){
                  // attach match to program meta for downstream reporting/prediction
                  meta.lastSlotSequenceMatch = meta.lastSlotSequenceMatch || [];
                  meta.lastSlotSequenceMatch.push({ mint: m, prevSlot, initSlot: obsSlot, reason: 'N-1:mint+authorities+poolAccount(uninit) -> N:poolInitialized', details: { prevLogs: prevLogs.slice(0,400), currLogs: sampleLogs.slice(0,400) } });
                }
              }
            }
          }catch(e){}
        }
      }catch(e){}

      // If initialize observed, run deeper analysis per-mint
      if(kind === 'initialize' && Array.isArray(ev.freshMints) && ev.freshMints.length>0){
        const details = [];
        for(const m of ev.freshMints.slice(0,3)){
          try{
            const first = await getFirstSignatureCached(m);
            const txSlotLocal = (first && first.slot) ? first.slot : (ev && (ev.slot || ev.blockSlot || ev.blockNumber) || null);
            const txBlockTime = ev.blockTime || ev.txBlock || (first && first.blockTime) || null;
            const prev = await mintPreviouslySeen(m, txSlotLocal, txBlockTime, ev.signature || ev.sig || null).catch(()=>null);
            // run Jupiter quote to estimate tradability and price-impact
            let jres = null;
            try{
              const jclient = createJupiterApiClient();
              const q = await jclient.quoteGet({ inputMint: 'So11111111111111111111111111111111111111112', outputMint: m, amount: Math.floor(1 * 1e9), slippageBps: 100 });
              jres = q || null;
            }catch(e){ jres = null; }
            details.push({ mint: m, first, prev, jres });
          }catch(e){ details.push({ mint: m, err: String(e) }); }
        }
        // attach analysis to meta for downstream reporting
        meta.lastInitializeAnalysis = details;
      }

      // run prediction (may consider meta.lastInitializeAnalysis)
      const prediction = await this.predictForProgram(p, meta);
      this.emit('prediction', prediction);
    }catch(e){ console.error('[ProgramMonitor] event handler error', e); }
  }

  predictForProgram(programId, meta){
    // Simple heuristics:
    // - If recent includes 'initialize' and no pool_creation -> predict 'pool_creation'
    // - If recent includes 'pool_creation' -> predict 'swap'
    // - If recent contains multiple 'swap' -> predict 'swap'
    // Confidence is heuristic (0-1)
    const events = meta.events.slice().reverse(); // newest first
    const kinds = events.map(e=>e.kind || 'unknown').slice(0,8);
    const now = this._now();
    let prediction = { program: programId, prediction: 'unknown', confidence: 0, reason: '', sample: kinds.slice(0,5) };
    const hasInit = kinds.includes('initialize');
    const hasPool = kinds.includes('pool_creation');
    const swapCount = kinds.filter(k=>k==='swap').length;
    // Boost logic using initialize analysis when available
    if(meta.lastInitializeAnalysis && Array.isArray(meta.lastInitializeAnalysis) && meta.lastInitializeAnalysis.length>0){
      // If any mint is not previously seen and Jupiter quote exists with low price impact, lean to pool_creation
      for(const a of meta.lastInitializeAnalysis){
        try{
          const notSeen = (a.prev === false || a.prev === null);
          const jpi = a.jres && (a.jres.priceImpactPct || a.jres.priceImpact || a.jres?.routesInfos?.[0]?.priceImpactPct || null);
          const hasGoodQuote = !!a.jres && jpi !== undefined && jpi !== null && Math.abs(Number(jpi)) < 0.05; // <5% impact
          if(notSeen && hasGoodQuote){ prediction.prediction = 'pool_creation'; prediction.confidence = 0.9; prediction.reason = 'initialize + first-sig match + low price-impact on Jupiter'; prediction.sample = kinds.slice(0,5); return prediction; }
          if(notSeen && a.jres){ prediction.prediction = 'pool_creation'; prediction.confidence = 0.8; prediction.reason = 'initialize + first-sig match + quote exists'; prediction.sample = kinds.slice(0,5); return prediction; }
        }catch(e){}
      }
    }
    if(hasInit && !hasPool){ prediction.prediction = 'pool_creation'; prediction.confidence = 0.7; prediction.reason = 'recent initialize without pool_creation'; }
    else if(hasPool){ prediction.prediction = 'swap'; prediction.confidence = 0.8; prediction.reason = 'recent pool_creation observed'; }
    else if(swapCount >= 2){ prediction.prediction = 'swap'; prediction.confidence = 0.6; prediction.reason = 'multiple swaps observed'; }
    else if(kinds[0] && kinds[0] !== 'unknown'){ prediction.prediction = kinds[0]; prediction.confidence = 0.4; prediction.reason = 'most recent kind fallback'; }
    // add timing metadata
    prediction.lastSeen = meta.lastSeen;
    prediction.ageMs = now - meta.lastSeen;
    // Boost if we detected the N-1 -> N slot sequence for a mint
    try{
      if(Array.isArray(meta.lastSlotSequenceMatch) && meta.lastSlotSequenceMatch.length>0){
        prediction.prediction = 'swap';
        prediction.confidence = Math.max(prediction.confidence || 0, 0.95);
        prediction.reason = (prediction.reason ? (prediction.reason + ' ; ') : '') + 'detected N-1:create+authorities+poolAccount(uninit) -> N:poolInitialized';
        prediction.sequence = meta.lastSlotSequenceMatch.slice(-3);
      }
    }catch(e){}
    return prediction;
  }

  summary(){
    const out = [];
    for(const [p,meta] of this.programs.entries()){
      out.push({ program: p, lastSeen: meta.lastSeen, counts: meta.counts, recent: meta.events.map(e=>e.kind).slice(-5) });
    }
    return out;
  }
}

module.exports = { ProgramMonitor };
