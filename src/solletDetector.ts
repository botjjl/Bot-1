import { VersionedTransaction } from '@solana/web3.js';

export function detectSollet(transaction: any, meta?: any): boolean {
  try{
    // check static account keys (VersionedTransaction) if present
    if(transaction && transaction.message && typeof transaction.message.staticAccountKeys === 'function'){
      const keys = transaction.message.staticAccountKeys();
      for(const k of keys){ if(String(k).includes('So111')) return true; }
    }

    // fallback: parsed instructions
    if(transaction && transaction.message && Array.isArray(transaction.message.instructions)){
      for(const ix of transaction.message.instructions){
        const pid = (ix.programId || ix.programIdString || ix.program) || '';
        if(String(pid).includes('So111')) return true;
        // parsed instruction types or parsed.info may include initialize markers
        try{
          const parsedType = (ix.parsed && (ix.parsed.type || ix.parsed.instruction)) || ''; 
          if(String(parsedType).toLowerCase().includes('initializemint') || String(parsedType).toLowerCase().includes('initialize_mint') || String(parsedType).toLowerCase().includes('initialize mint')) return true;
          const info = ix.parsed && ix.parsed.info || ix.info || null;
          if(info){ if(info.mint && String(info.mint).includes('So111')) return true; if(info.newAccount && String(info.newAccount).includes('So111')) return true; }
        }catch(_e){}
        if(ix.accounts && ix.accounts.some((a:any)=>String(a).includes('So111'))) return true;
      }
    }

    // meta: innerInstructions or accountKeys
    if(meta){
      // check textual logs for initialize markers (common sollet-style create)
      try{
        if(meta.logMessages && Array.isArray(meta.logMessages)){
          const joined = meta.logMessages.join('\n').toLowerCase();
          if(joined.includes('instruction: initializemint') || joined.includes('initialize mint') || joined.includes('initialize_mint') || joined.includes('createidempotent')) return true;
        }
      }catch(_e){}
      if(Array.isArray(meta.innerInstructions)){
        for(const inner of meta.innerInstructions){
          if(Array.isArray(inner.instructions)){
            for(const i of inner.instructions){
              const pid = i.programId || i.programIdString || i.program;
              if(String(pid).includes('So111')) return true;
            }
          }
        }
      }
      if(Array.isArray(meta.preTokenBalances)){
        for(const b of meta.preTokenBalances){ if(String(b.owner || b.accountIndex || b.mint).includes('So111')) return true; }
      }
    }

    return false;
  }catch(e){ return false; }
}

export default detectSollet;
