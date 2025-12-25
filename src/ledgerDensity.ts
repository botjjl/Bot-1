export class LedgerDensity {
  private lastSlots: number[] = [];
  private maxLen: number;

  constructor(maxLen = 6){
    this.maxLen = maxLen;
  }

  update(slot: number): { densityCount: number, strong: boolean }{
    this.lastSlots.push(slot);
    if(this.lastSlots.length > this.maxLen) this.lastSlots.shift();

    let density = 0;
    for(let i=0; i+1 < this.lastSlots.length; i++){
      if(this.lastSlots[i+1] === this.lastSlots[i] + 1) density++;
    }
    const strong = density >= 2;
    return { densityCount: density, strong };
  }

  reset(){ this.lastSlots = []; }
}

export default LedgerDensity;
