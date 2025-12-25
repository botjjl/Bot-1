#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const samplesPath = path.join(__dirname, '..', 'src', 'simulation', 'sample_mints_enriched.json');
const out = process.env.FSM_METRICS_FILE || '/tmp/fsm_metrics.jsonl';
try{
  const raw = fs.readFileSync(samplesPath,'utf8');
  const arr = JSON.parse(raw);
  const lines = arr.map(s => {
    const obj = {
      mint: s.mint || s.token || null,
      signature: s.signature || s.sig || null,
      slot: s.slot || null,
      mask: s.mask || s.mask || 0,
      maskNames: s.maskNames || [],
      ledgerStrongSignal: s.ledgerStrongSignal || s.ledgerStrong || false,
      solletCreatedHere: s.solletCreatedHere || false,
      time: s.time || null
    };
    return JSON.stringify(obj);
  }).join('\n');
  fs.writeFileSync(out, lines + '\n', 'utf8');
  console.error('Wrote', arr.length, 'metrics to', out);
  process.exit(0);
}catch(e){ console.error('Error generating metrics from samples', e && e.stack || e); process.exit(2); }
