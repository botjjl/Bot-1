#!/usr/bin/env node
// try to register ts-node if available so we can require .ts sources directly
try{ require('ts-node').register({ transpileOnly: true }); }catch(e){}
const agg = require('../src/ledgerWindowAggregator.ts').default;
const path = require('path');
const fs = require('fs');

function loadSamples(){
  const p = path.join(__dirname, '..', 'src', 'simulation', 'sample_mints_enriched.json');
  const raw = fs.readFileSync(p,'utf8');
  return JSON.parse(raw);
}

async function run(){
  const samples = loadSamples();
  // clear internal map by recreating module? aggregator is singleton; we reset by removing entries
  try{ agg['map'] = new Map(); agg['seenSigs'] = new Map(); }catch(e){}
  console.error('ALLOW_SOLLET_ONLY=', process.env.ALLOW_SOLLET_ONLY || 'false');
  // add samples
  for(const s of samples){
    try{
      agg.addSample(s.mint, { ledgerMask: s.mask||0, ledgerStrong: !!s.ledgerStrongSignal, solletCreatedHere: !!s.solletCreatedHere, sig: s.signature||s.sig||'', ts: Date.now() });
    }catch(e){}
  }
  // compute aggregated per unique mint
  const seen = new Set();
  for(const s of samples){
    if(seen.has(s.mint)) continue; seen.add(s.mint);
    const aggRes = agg.getAggregated(s.mint);
    console.log(JSON.stringify({ mint: s.mint, aggregatedMask: aggRes.aggregatedMask, ledgerStrong: aggRes.ledgerStrong, solletCreatedHere: aggRes.solletCreatedHere, mergedSignal: aggRes.mergedSignal }));
  }
}

run().catch(e=>{ console.error(e); process.exit(2); });
