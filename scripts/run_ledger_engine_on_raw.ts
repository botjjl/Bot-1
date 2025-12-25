#!/usr/bin/env ts-node
const { LedgerSignalEngine } = require('../src/simulation/ledger_signal_engine');
import fs from 'fs';
import path from 'path';
import { LEDGER_BIT_BASE_SHIFT, LEDGER_WEIGHTS_BY_BIT } from '../src/ledgerWeights';

const samplesPath = path.join(__dirname, 'raw_samples_only.json');
if(!fs.existsSync(samplesPath)){ console.error('raw samples file missing:', samplesPath); process.exit(1); }
const samples = JSON.parse(fs.readFileSync(samplesPath,'utf8')) as any[];

const engine = new LedgerSignalEngine({ windowSlots: 5, densityThreshold: 2, requiredBits: 2 });

let slot = 1000000;
for(const s of samples){
  slot += 1;
  const ev: any = { slot, freshMints: [s.mint], sampleLogs: JSON.stringify(s.rawFull || {}), solletCreated: !!s.solletCreatedHere, transaction: s.rawFull && s.rawFull.transaction ? s.rawFull.transaction : null, meta: null };
  // if rawFull.maskNames exists, include as logs string
  if(s.rawFull && Array.isArray(s.rawFull.maskNames) && s.rawFull.maskNames.length) ev.sampleLogs = s.rawFull.maskNames.join('\n');
  engine.processEvent(ev);
}

console.log('Processed', samples.length, 'samples — extracting masks per mint');
const out: any[] = [];
for(const s of samples){
  const m = s.mint;
  const mask = engine.getMaskForMint(m, null);
  // count bits
  let cnt = 0; let mm = mask; while(mm){ cnt += mm & 1; mm >>>= 1; }
  // compute score from LEDGER_WEIGHTS_BY_BIT
  let score = 0; for(const k of Object.keys(LEDGER_WEIGHTS_BY_BIT)){ const bit = Number(k); if(mask & bit) score += LEDGER_WEIGHTS_BY_BIT[bit] || 0; }
  out.push({ mint: m, mask, bits: cnt, score, solletCreatedHere: !!s.solletCreatedHere });
}

const outPath = require('path').join(__dirname, 'raw_samples_with_masks.json');
try{
  require('fs').writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('Wrote results to', outPath);
}catch(e){ console.error('Failed to write output file', e); }
console.log(JSON.stringify(out, null, 2));
