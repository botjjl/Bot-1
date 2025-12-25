// Simple in-memory windowed aggregator for ledger samples per mint
type Sample = {
  id: string;
  ts: number;
  ledgerMask: number;
  ledgerStrong: boolean;
  solletCreatedHere: boolean;
  sig?: string;
};

const DEFAULT_WINDOW_MS = 10_000; // 10s window
const DEFAULT_SEEN_SIG_TTL_MS = Number(process.env.SEEN_SIG_TTL_MS || 5 * 60 * 1000); // 5 minutes
// Allow treating sollet-only evidence as sufficient to set the sollet-created bit
// Default now enabled (can be overridden with ALLOW_SOLLET_ONLY=false)
const ALLOW_SOLLET_ONLY = String(process.env.ALLOW_SOLLET_ONLY || 'true').toLowerCase() === 'true';

// Ledger bit layout constants (match engine base shift)
export const LEDGER_BIT_BASE_SHIFT = 6;
export const BIT_SOLLET_CREATED = 1 << (LEDGER_BIT_BASE_SHIFT + 9);

export class LedgerWindowAggregator {
  private map: Map<string, Sample[]> = new Map();
  // map sig -> ts when first seen (for TTL based dedupe)
  private seenSigs: Map<string, number> = new Map();

  addSample(mint: string, sample: Omit<Sample,'id'|'ts'> & { ts?: number }){
    const ts = sample.ts || Date.now();
    const sig = sample.sig || '';
    // avoid duplicate samples by signature
    this.pruneSeenSigs(ts);
    if(sig && this.seenSigs.has(sig)) return;
    if(sig) this.seenSigs.set(sig, ts);
    const id = `${mint}:${ts}:${Math.random().toString(36).slice(2,8)}`;
      const s: Sample = { id, ts, ledgerMask: sample.ledgerMask||0, ledgerStrong: !!sample.ledgerStrong, solletCreatedHere: !!sample.solletCreatedHere, sig };
    // prune window for this mint to avoid unbounded growth
    this.pruneWindow(mint, DEFAULT_WINDOW_MS);
    const arr = this.map.get(mint) || [];
    arr.push(s);
    this.map.set(mint, arr);
    return s;
  }

  // prune old seen signatures older than TTL
  private pruneSeenSigs(now: number){
    if(!DEFAULT_SEEN_SIG_TTL_MS || this.seenSigs.size===0) return;
    const cutoff = now - DEFAULT_SEEN_SIG_TTL_MS;
    for(const [sig, ts] of Array.from(this.seenSigs.entries())){
      if(ts < cutoff) this.seenSigs.delete(sig);
    }
  }

  // Remove old samples beyond window
  private pruneWindow(mint: string, windowMs: number){
    const now = Date.now();
    const arr = this.map.get(mint) || [];
    const filtered = arr.filter(x => (now - x.ts) <= windowMs);
    if(filtered.length !== arr.length) this.map.set(mint, filtered);
    return filtered;
  }

  // Return aggregated info for mint over separate windows.
  // ledgerWindowMs: time window to include ledger bit samples
  // solletWindowMs: time window to include solletCreatedHere samples
  getAggregated(mint: string, ledgerWindowMs = DEFAULT_WINDOW_MS, solletWindowMs = DEFAULT_WINDOW_MS){
    const now = Date.now();
    // prune stored samples for this mint first, using the larger window
    const arr = this.pruneWindow(mint, Math.max(ledgerWindowMs, solletWindowMs));
    const ledgerCut = now - ledgerWindowMs;
    const solletCut = now - solletWindowMs;
    const ledgerSamples = arr.filter(x => x.ts >= ledgerCut);
    const solletSamples = arr.filter(x => x.ts >= solletCut);
    if(ledgerSamples.length===0 && solletSamples.length===0) return { count:0, aggregatedMask:0, ledgerStrong:false, solletCreatedHere:false, bitCounts: {} as Record<number,number>, firstTs:0, lastTs:0 };

    let aggregatedMask = 0;
    let ledgerStrong = false;
    let solletCreatedHere = false;
    let mergedSignal = false;
    const bitCounts: Record<number,number> = {};
    let firstTs = Infinity; let lastTs = 0;

    // ledger bits/counts from ledgerSamples
    for(const s of ledgerSamples){
      aggregatedMask |= s.ledgerMask;
      ledgerStrong = ledgerStrong || s.ledgerStrong;
      firstTs = Math.min(firstTs, s.ts);
      lastTs = Math.max(lastTs, s.ts);
      // count bits but store counts using absolute bit index (respecting base shift)
      let m = s.ledgerMask; let bitIndex = 0;
      while(m){
        if(m & 1){
          const absoluteIdx = LEDGER_BIT_BASE_SHIFT + bitIndex;
          bitCounts[absoluteIdx] = (bitCounts[absoluteIdx]||0) + 1;
        }
        m >>= 1; bitIndex++;
      }
    }

    // sollet evidence considered in separate window
    for(const s of solletSamples){
      solletCreatedHere = solletCreatedHere || s.solletCreatedHere;
      firstTs = Math.min(firstTs, s.ts);
      lastTs = Math.max(lastTs, s.ts);
    }

    // If we have sollet evidence and ledger evidence within their windows,
    // consider them merged (detector-first) and include the sollet-created
    // bit in the aggregated mask so scoring and downstream logic see it.
    // Require actual ledger bits (non-zero aggregatedMask) rather than just
    // the presence of ledger samples to avoid treating empty samples as evidence.
    if(solletCreatedHere && (aggregatedMask !== 0 || ledgerStrong || ALLOW_SOLLET_ONLY)){
      aggregatedMask |= BIT_SOLLET_CREATED;
      mergedSignal = true;
    }

    if(firstTs===Infinity) firstTs = 0;
    return { count: Math.max(ledgerSamples.length, solletSamples.length), aggregatedMask, ledgerStrong, solletCreatedHere, mergedSignal, bitCounts, firstTs, lastTs };
  }

  // helper to compute score from a weights map (bit-value keyed by bit index)
  computeScoreFromWeights(aggregatedMask: number, weights: Record<number,number>){
    let score = 0;
    for(const k of Object.keys(weights)){
      const idx = Number(k);
      const bit = 1 << idx;
      if(aggregatedMask & bit) score += weights[idx] || 0;
    }
    return score;
  }
}

export default new LedgerWindowAggregator();
