#!/usr/bin/env node
/**
 * Optional live integration probe: subscribes to program logs and forwards parsed transactions
 * to `LedgerSignalEngine` for real-time validation.
 *
 * Usage:
 *   SOLANA_RPC_URL="https://api.mainnet-beta.solana.com" PROGRAMS="<comma-list-of-program-ids>" node src/simulation/integration_onlogs_probe.js
 *
 * The script will subscribe to `onLogs` for the provided programs and, when logs arrive,
 * will fetch the corresponding transaction via `getTransaction` and feed the `LedgerSignalEngine`.
 * This is optional and intended for environments with a working RPC and sufficient rate limits.
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const { LedgerSignalEngine } = require('./ledger_signal_engine');

(async ()=>{
  const RPC = process.env.SOLANA_RPC_URL || process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
  // Use canonical program list only (ignore env overrides)
  const DEFAULT_PROGS = ['9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp','6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'];
  const PROGS = DEFAULT_PROGS.slice();
  const conn = new Connection(RPC, 'confirmed');
  const eng = new LedgerSignalEngine({ windowSlots: 5, densityThreshold: 2 });

  // Throttling/queue controls
  const sigQueue = [];
  let queueActive = false;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Per-program last signature-poll timestamp to avoid excessive getSignaturesForAddress calls
  const lastSigPoll = new Map();
  const SIG_POLL_INTERVAL_MS = Number(process.env.INTEGRATION_SIG_POLL_MS || 5000);
  const FETCH_DELAY_MS = Number(process.env.INTEGRATION_FETCH_DELAY_MS || 600); // delay between fetches

  async function fetchTransactionWithRetries(signature, tries = 3) {
    let attempt = 0;
    let lastErr = null;
    while (attempt < tries) {
      try {
        const tx = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        return tx;
      } catch (e) {
        lastErr = e;
        const backoff = 500 * Math.pow(2, attempt);
        await sleep(backoff + Math.floor(Math.random()*200));
      }
      attempt++;
    }
    throw lastErr;
  }

  async function processQueue() {
    if (queueActive) return;
    queueActive = true;
    while (sigQueue.length) {
      const { signature, program } = sigQueue.shift();
      try {
        const tx = await fetchTransactionWithRetries(signature, 3).catch(e => { throw e; });
        if (!tx) { console.error('no tx for', signature); continue; }
        const ev = {
          time: new Date().toISOString(),
          program,
          signature,
          kind: null,
          freshMints: [],
          sampleLogs: (tx.meta && tx.meta.logMessages) || [],
          transaction: tx.transaction || tx,
          meta: tx.meta || tx
        };
        try{
          const pre = (tx.meta && tx.meta.preTokenBalances) || [];
          const post = (tx.meta && tx.meta.postTokenBalances) || [];
          for(const b of [].concat(pre||[], post||[])) if(b && b.mint) ev.freshMints.push(b.mint);
        }catch(_e){}
        console.error('feeding event from onLogs sig=', signature, 'mints=', ev.freshMints.slice(0,5));
        try{ eng.processEvent(ev); }catch(e){ console.error('engine processEvent error', e && e.message || e); }
      } catch (e) {
        console.error('fetchTransactionWithRetries failed for', signature, e && e.message || e);
      }
      await sleep(FETCH_DELAY_MS);
    }
    queueActive = false;
  }

  console.error('Subscribing to programs:', PROGS);
  for(const p of PROGS){
    try{
      const pk = new PublicKey(p);
      const subId = conn.onLogs(pk, async (logs, ctx) => {
        try{
          // Prefer the signature provided by the subscription context if available
          const sig = (ctx && ctx.signature) || (logs && logs.signature) || null;
          if (sig) {
            sigQueue.push({ signature: sig, program: p });
            processQueue().catch(e => console.error('processQueue error', e && e.message || e));
            return;
          }

          // If no signature in context, only poll signatures infrequently per-program
          const last = lastSigPoll.get(p) || 0;
          const now = Date.now();
          if (now - last < SIG_POLL_INTERVAL_MS) return;
          lastSigPoll.set(p, now);

          try{
            const sigs = await conn.getSignaturesForAddress(pk, { limit: 1 });
            if(!Array.isArray(sigs) || sigs.length===0) return;
            const target = sigs[0] && sigs[0].signature;
            if(!target) return;
            sigQueue.push({ signature: target, program: p });
            processQueue().catch(e => console.error('processQueue error', e && e.message || e));
            }catch(e){
            console.error('onLogs signature-poll error', e && e.message || e);
          }
        }catch(_e){ }
      }, 'confirmed');
      console.error('subscribed', p, 'subId=', subId);
    }catch(e){ console.error('subscribe error for', p, e && e.message || e); }
  }

  // simple periodic dump of state for diagnostics
  setInterval(()=>{
    try{
      console.error('--- ledger diagnostic ---');
      for(const s of eng.slotOrder){
        const b = eng.slotBuckets.get(s);
        try{ console.error('slot', s, 'count', b.count, 'mints', Array.from(b.mints.keys()).slice(0,6)); }catch(_e){}
      }
    }catch(_e){}
  }, 15000);

})();
