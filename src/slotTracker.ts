import EventEmitter from 'events';
import rpcPool from './utils/rpcPool';

export type SlotEvent = { slot: number, ts: number };

export class SlotTracker extends EventEmitter {
  private interval: any = null;
  private pollIntervalMs: number;
  private lastSlot: number | null = null;

  constructor(pollIntervalMs = 500) {
    super();
    this.pollIntervalMs = pollIntervalMs;
  }

  start(){
    if(this.interval) return;
    this.interval = setInterval(() => this.poll(), this.pollIntervalMs);
    // initial poll
    this.poll().catch(()=>{});
  }

  stop(){
    if(this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private async poll(){
    try{
      const conn = rpcPool.getRpcConnection({ commitment: 'finalized' });
      const slot = await (conn as any).getSlot();
      const ts = Date.now();
      if(this.lastSlot === null || slot !== this.lastSlot){
        this.lastSlot = slot;
        this.emit('slot', { slot, ts } as SlotEvent);
      }
    }catch(e){
      // ignore transient errors; rpcPool logs
    }
  }
}

export default SlotTracker;
