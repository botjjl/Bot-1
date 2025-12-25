#!/usr/bin/env ts-node
import fs from 'fs';
import path from 'path';

const inPath = path.join(__dirname, '../src/simulation/sample_mints_enriched.json');
const outPath = path.join(__dirname, 'raw_samples_only.json');

function main(){
  if(!fs.existsSync(inPath)){ console.error('Input sample file not found:', inPath); process.exit(1); }
  const arr = JSON.parse(fs.readFileSync(inPath,'utf8')) as any[];
  const rawOnly = arr.map(x => ({ mint: x.mint, signature: x.signature, rawFull: x.rawFull, solletCreatedHere: x.solletCreatedHere, ledgerStrong: x.ledgerStrong }));
  fs.writeFileSync(outPath, JSON.stringify(rawOnly, null, 2));
  console.log('Wrote', rawOnly.length, 'raw samples to', outPath);
}

main();
