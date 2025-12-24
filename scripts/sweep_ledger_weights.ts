#!/usr/bin/env ts-node
import fs from 'fs';
import path from 'path';

const SAMPLE_PATH = path.join(__dirname, '../src/simulation/sample_mints_enriched.json');

type Sample = any;

function parseSamples(): Sample[]{
  const raw = fs.readFileSync(SAMPLE_PATH, 'utf8');
  return JSON.parse(raw);
}

const LEDGER_BIT_BASE_SHIFT = 6;
const bitNames: Record<number,string> = {};
bitNames[LEDGER_BIT_BASE_SHIFT + 0] = 'ACCOUNT_CREATED';
bitNames[LEDGER_BIT_BASE_SHIFT + 1] = 'ATA_CREATED';
bitNames[LEDGER_BIT_BASE_SHIFT + 2] = 'SAME_AUTH';
bitNames[LEDGER_BIT_BASE_SHIFT + 3] = 'PROGRAM_INIT';
bitNames[LEDGER_BIT_BASE_SHIFT + 4] = 'SLOT_DENSE';
bitNames[LEDGER_BIT_BASE_SHIFT + 5] = 'LP_STRUCT';
bitNames[LEDGER_BIT_BASE_SHIFT + 6] = 'CLEAN_FUNDING';
bitNames[LEDGER_BIT_BASE_SHIFT + 7] = 'SLOT_ALIGNED';
bitNames[LEDGER_BIT_BASE_SHIFT + 8] = 'CREATOR_EXPOSED';
bitNames[LEDGER_BIT_BASE_SHIFT + 9] = 'SOLLET_CREATED';

const BASE_WEIGHTS: Record<number,number> = {};
BASE_WEIGHTS[LEDGER_BIT_BASE_SHIFT + 0] = 0.06;
BASE_WEIGHTS[LEDGER_BIT_BASE_SHIFT + 1] = 0.05;
BASE_WEIGHTS[LEDGER_BIT_BASE_SHIFT + 2] = 0.04;
BASE_WEIGHTS[LEDGER_BIT_BASE_SHIFT + 3] = 0.05;
BASE_WEIGHTS[LEDGER_BIT_BASE_SHIFT + 4] = 0.05;
BASE_WEIGHTS[LEDGER_BIT_BASE_SHIFT + 5] = 0.07;
BASE_WEIGHTS[LEDGER_BIT_BASE_SHIFT + 6] = 0.08;
BASE_WEIGHTS[LEDGER_BIT_BASE_SHIFT + 7] = 0.06;
BASE_WEIGHTS[LEDGER_BIT_BASE_SHIFT + 8] = 0.08;
BASE_WEIGHTS[LEDGER_BIT_BASE_SHIFT + 9] = 0.06;

function epochMs(t?: string | number | null){ if(!t) return 0; if(typeof t === 'number') return t; return new Date(t).getTime(); }

function aggregateByMint(samples: Sample[], decayMs = 30_000){
  const byMint: Record<string, any[]> = {};
  for(const s of samples){
    const mint = s.mint || s.tokenAddress;
    byMint[mint] = byMint[mint] || [];
    byMint[mint].push(s);
  }
  const result: Array<any> = [];
  for(const mint of Object.keys(byMint)){
    const arr = byMint[mint];
    const latestTs = Math.max(...arr.map(x=>epochMs(x.rawFull?.time || x.time || x.ts || 0)));
    const perBitCounts: Record<number,number> = {};
    let aggregatedMask = 0;
    let sollet = false;
    for(const s of arr){
      const ts = epochMs(s.rawFull?.time || s.time || s.ts || 0);
      const decay = Math.exp(-(latestTs - ts)/decayMs);
      const mask = Number(s.rawFull?.mask || s.ledgerMask || 0) || 0;
      const sol = !!s.solletCreatedHere;
      if(sol){ sollet = true; const solIdx = LEDGER_BIT_BASE_SHIFT + 9; perBitCounts[solIdx] = (perBitCounts[solIdx]||0) + decay; aggregatedMask |= (1<<solIdx); }
      let m = mask; let idx=0;
      while(m){ if(m & 1){ perBitCounts[idx] = (perBitCounts[idx]||0) + decay; aggregatedMask |= (1<<idx); } m >>=1; idx++; }
    }
    result.push({ mint, count: arr.length, latestTs, aggregatedMask, perBitCounts, sollet });
  }
  return result;
}

function computeScore(aggMask: number, weights: Record<number,number>){
  let s = 0;
  for(const k of Object.keys(weights)){
    const idx = Number(k);
    if(aggMask & (1<<idx)) s += weights[idx] || 0;
  }
  return s;
}

function sweep(){
  const samples = parseSamples();
  const byMint = aggregateByMint(samples, 30_000);
  const scales = [0.0,0.25,0.5,0.75,1,1.5,2];
  const threshold = Number(process.env.LEDGER_EARLY_SCORE_THRESHOLD || 0.06);
  console.log('Mints:', byMint.length, 'Threshold:', threshold);
  for(const scale of scales){
    const weights: Record<number,number> = {};
    for(const k of Object.keys(BASE_WEIGHTS)) weights[Number(k)] = BASE_WEIGHTS[Number(k)] * scale;
    let hits = 0; let hitsWithSollet = 0; let totalScore = 0;
    for(const m of byMint){
      const score = computeScore(m.aggregatedMask, weights);
      totalScore += score;
      if(score >= threshold){ hits++; if(m.sollet) hitsWithSollet++; }
    }
    console.log(`scale=${scale.toFixed(2)}  hits=${hits}/${byMint.length}  hitsWithSollet=${hitsWithSollet}  avgScore=${(totalScore/byMint.length).toFixed(4)}`);
  }
  // per-bit hit rates
  const globalBitCounts: Record<number,number> = {};
  for(const m of byMint){
    for(const kStr of Object.keys(m.perBitCounts)){
      const k = Number(kStr);
      globalBitCounts[k] = (globalBitCounts[k]||0) + (m.perBitCounts[k]||0);
    }
  }
  console.log('\nPer-bit (decayed) totals across mints:');
  for(const k of Object.keys(bitNames)){
    const idx = Number(k);
    console.log(`${bitNames[idx] || idx}: ${(globalBitCounts[idx]||0).toFixed(2)}`);
  }
}

sweep();
