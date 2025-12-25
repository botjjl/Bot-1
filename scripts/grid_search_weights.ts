#!/usr/bin/env ts-node
import fs from 'fs';
import path from 'path';
import { LEDGER_BIT_BASE_SHIFT, LEDGER_WEIGHTS_BY_INDEX } from '../src/ledgerWeights';

const SAMPLE_PATH = path.join(__dirname, '../src/simulation/sample_mints_enriched.json');
const BIT_SOLLET_IDX = LEDGER_BIT_BASE_SHIFT + 9;

type Sample = any;

function parseSamples(): Sample[]{
  const raw = fs.readFileSync(SAMPLE_PATH, 'utf8');
  return JSON.parse(raw);
}

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
      if(sol){ sollet = true; perBitCounts[BIT_SOLLET_IDX] = (perBitCounts[BIT_SOLLET_IDX]||0) + decay; aggregatedMask |= (1<<BIT_SOLLET_IDX); }
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

function evaluate(byMint: any[], weights: Record<number,number>, threshold: number){
  let hits = 0, hitsWithSollet = 0, total = byMint.length;
  for(const m of byMint){
    const score = computeScore(m.aggregatedMask, weights);
    if(score >= threshold){ hits++; if(m.sollet) hitsWithSollet++; }
  }
  const falsePos = hits - hitsWithSollet;
  return { hits, hitsWithSollet, falsePos, total };
}

function coordDescent(byMint: any[], baseWeights: Record<number,number>, candidates: number[], threshold: number, rounds = 4, alpha = 0.5){
  // alpha penalizes false positives in objective
  const bitIndices = Object.keys(baseWeights).map(k=>Number(k));
  const weights: Record<number,number> = {};
  for(const k of bitIndices) weights[k] = baseWeights[k];

  let best = evaluate(byMint, weights, threshold);
  let bestObj = best.hitsWithSollet - alpha * best.falsePos;

  for(let r=0;r<rounds;r++){
    for(const bit of bitIndices){
      let localBestScale = 1;
      let localBestObj = -Infinity;
      for(const scale of candidates){
        const trialWeights = Object.assign({}, weights);
        trialWeights[bit] = baseWeights[bit] * scale;
        const res = evaluate(byMint, trialWeights, threshold);
        const obj = res.hitsWithSollet - alpha * res.falsePos;
        if(obj > localBestObj){ localBestObj = obj; localBestScale = scale; }
      }
      weights[bit] = baseWeights[bit] * localBestScale;
    }
    const resAll = evaluate(byMint, weights, threshold);
    const objAll = resAll.hitsWithSollet - alpha * resAll.falsePos;
    if(objAll > bestObj){ bestObj = objAll; best = resAll; }
  }
  return { weights, best, bestObj };
}

function main(){
  const samples = parseSamples();
  const byMint = aggregateByMint(samples, 30_000);
  // start from centralized ledger weights (copy to avoid mutation)
  const baseWeights: Record<number,number> = {};
  for(const k of Object.keys(LEDGER_WEIGHTS_BY_INDEX)) baseWeights[Number(k)] = LEDGER_WEIGHTS_BY_INDEX[Number(k)];

  const candidates = [0,0.5,1,1.5,2];
  const threshold = Number(process.env.LEDGER_EARLY_SCORE_THRESHOLD || 0.06);
  const alpha = Number(process.env.SWEEP_FALSE_POS_PENALTY || 0.5);
  const rounds = Number(process.env.SWEEP_ROUNDS || 4);

  console.log('Running coordinate-descent grid search — mints=', byMint.length, 'threshold=', threshold, 'alpha=', alpha);
  const out = coordDescent(byMint, baseWeights, candidates, threshold, rounds, alpha);
  console.log('\nBest evaluation: ', out.best);
  console.log('Objective value:', out.bestObj.toFixed(4));
  console.log('\nFinal per-bit weights:');
  for(const k of Object.keys(out.weights).map(x=>Number(x)).sort((a,b)=>a-b)){
    console.log(`${k}: ${out.weights[k].toFixed(4)}`);
  }
}

main();
