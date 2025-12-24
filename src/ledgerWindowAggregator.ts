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

// Ledger bit layout constants (match engine base shift)
export const LEDGER_BIT_BASE_SHIFT = 6;
export const BIT_SOLLET_CREATED = 1 << (LEDGER_BIT_BASE_SHIFT + 9);

export class LedgerWindowAggregator {
  private map: Map<string, Sample[]> = new Map();
  private seenSigs: Set<string> = new Set();

  addSample(mint: string, sample: Omit<Sample,'id'|'ts'> & { ts?: number }){
    const ts = sample.ts || Date.now();
    const sig = sample.sig || '';
    // avoid duplicate samples by signature
    if(sig && this.seenSigs.has(sig)) return;
    if(sig) this.seenSigs.add(sig);
    const id = `${mint}:${ts}:${Math.random().toString(36).slice(2,8)}`;
      const s: Sample = { id, ts, ledgerMask: sample.ledgerMask||0, ledgerStrong: !!sample.ledgerStrong, solletCreatedHere: !!sample.solletCreatedHere, sig };
    const arr = this.map.get(mint) || [];
    arr.push(s);
    this.map.set(mint, arr);
    return s;
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
    const arr = this.map.get(mint) || [];
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
      let m = s.ledgerMask; let bitIndex = 0;
      while(m){
        if(m & 1){ bitCounts[bitIndex] = (bitCounts[bitIndex]||0) + 1; }
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
    if(solletCreatedHere && (ledgerSamples.length > 0 || ledgerStrong)){
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
