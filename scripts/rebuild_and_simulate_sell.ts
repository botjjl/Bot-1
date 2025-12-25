#!/usr/bin/env ts-node
import { createJupiterApiClient } from '@jup-ag/api';
const rpcPool = require('../src/utils/rpcPool').default;
const { loadKeypair } = require('../src/wallet');
const { VersionedTransaction, Transaction, TransactionInstruction, PublicKey } = require('@solana/web3.js');

async function main(){
  const secret = process.env.BOT_SECRET || process.env.BOT_KEYPAIR || '';
  if(!secret) { console.error('Set BOT_SECRET (base64) to a keypair for testing'); process.exit(1); }
  const kp = loadKeypair(secret);
  const tokenMint = process.env.TEST_TOKEN_MINT || '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj';
  const buySol = Number(process.env.TEST_BUY_SOL || '0.005');
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const jupiter = createJupiterApiClient();
  const userPublicKey = kp.publicKey.toBase58();
  const connection = rpcPool.getRpcConnection();
  try{
    const buyAmountLamports = Math.floor(buySol * 1e9);
    const buyQuote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: tokenMint, amount: buyAmountLamports, slippageBps: Number(process.env.JUPITER_SLIPPAGE_BPS || '30') });
    const buySwapResp = await jupiter.swapPost({ swapRequest: { userPublicKey, wrapAndUnwrapSol: true, asLegacyTransaction: false, quoteResponse: buyQuote } });
    const buyBuf = Buffer.from(buySwapResp.swapTransaction, 'base64');
    let extractedOutAmount = 0;
    try{ const bt = VersionedTransaction.deserialize(buyBuf); const sim = await connection.simulateTransaction(bt).catch(()=>null); if(sim && sim.value && sim.value.postTokenBalances){ for(const p of sim.value.postTokenBalances){ if(p.mint===tokenMint && p.owner===userPublicKey){ extractedOutAmount = Number(p.amount||p.uiTokenAmount?.amount||0); break; } } } }catch(_){ }

    const sellAmountForQuote = (extractedOutAmount && extractedOutAmount>0) ? Math.floor(Number(extractedOutAmount)) : Math.floor(Number(buyQuote.outAmount || 0));
    const sellQuote = await jupiter.quoteGet({ inputMint: tokenMint, outputMint: SOL_MINT, amount: sellAmountForQuote, slippageBps: Number(process.env.JUPITER_SLIPPAGE_BPS || '30') });
    const sellSwapResp = await jupiter.swapPost({ swapRequest: { userPublicKey, wrapAndUnwrapSol: true, asLegacyTransaction: false, quoteResponse: sellQuote } });
    const swapB64 = sellSwapResp.swapTransaction;
    const swapBuf = Buffer.from(swapB64,'base64');
    const vt = VersionedTransaction.deserialize(swapBuf);
    const header = vt.message.header || { numRequiredSignatures:0 };
    const staticKeys = vt.message.accountKeys ? vt.message.accountKeys.map((k:any)=>(k.toBase58? k.toBase58() : String(k))) : [];
    const lookups = vt.message.addressTableLookups || [];
    const resolvedExtra: string[] = [];
    for(const l of lookups){
      try{ const lookupPub = new PublicKey(l.accountKey || l.account); const resp:any = await connection.getAddressLookupTable(lookupPub); const addrs = resp && resp.value && resp.value.state && resp.value.state.addresses ? resp.value.state.addresses : resp && resp.value && resp.value.addresses ? resp.value.addresses : []; const addrsStr = (addrs||[]).map((a:any)=>(a.toBase58? a.toBase58() : String(a))); resolvedExtra.push(...addrsStr); console.log('Resolved lookup', lookupPub.toBase58(), '->', addrsStr.length, 'addresses'); }catch(e){ console.log('Lookup fetch failed', String(e)); }
    }
    // Attempt 3: request Jupiter to produce a legacy transaction instead and simulate it
    try{
      console.log('\nAttempting swapPost with asLegacyTransaction=true to get legacy transaction');
      const sellSwapRespLegacy = await jupiter.swapPost({ swapRequest: { userPublicKey, wrapAndUnwrapSol: true, asLegacyTransaction: true, quoteResponse: sellQuote } });
      if(sellSwapRespLegacy && sellSwapRespLegacy.swapTransaction){
        const legacyB64 = sellSwapRespLegacy.swapTransaction;
        const legacyBuf = Buffer.from(legacyB64,'base64');
        try{
          const legacyTx = Transaction.from(legacyBuf);
          console.log('Simulating legacy transaction returned by Jupiter (asLegacyTransaction=true)');
          const simLegacy = await connection.simulateTransaction(legacyTx).catch((e:any)=>({ error: String(e) }));
          console.log('Simulation (legacy) result:', JSON.stringify(simLegacy, null, 2));
        }catch(e){ console.log('Failed to parse legacy transaction:', String(e)); }
      } else { console.log('Jupiter did not return a legacy swapTransaction'); }
    }catch(e){ console.log('swapPost asLegacyTransaction=true failed:', String(e)); }
    const fullKeys = staticKeys.concat(resolvedExtra);
    console.log('Full keys count:', fullKeys.length);

    const ci = vt.message.compiledInstructions || [];
    const instrs: any[] = [];
    for(const c of ci){
      const pid = fullKeys[c.programIdIndex];
      if(!pid){ console.log('Missing programId for index', c.programIdIndex, 'skipping instruction'); continue; }
      const programId = new PublicKey(pid);
      const accounts = (c.accounts||[]).map((ai:number)=>({ pubkey: new PublicKey(fullKeys[ai]), isSigner: ai < header.numRequiredSignatures, isWritable: true }));
      const data = Buffer.from(c.data || []);
      console.log('Reconstructed instruction programId=', programId.toBase58(), 'accounts=', accounts.length, 'dataLen=', data.length);
      instrs.push(new TransactionInstruction({ programId, keys: accounts, data }));
    }

    const merged = new Transaction();
    merged.add(...instrs);
    merged.feePayer = kp.publicKey;
    try{ merged.recentBlockhash = (await connection.getLatestBlockhashAndContext('confirmed')).value.blockhash; }catch(_){ }
    console.log('Simulating rebuilt legacy Transaction with', instrs.length, 'instructions');
    const sim = await connection.simulateTransaction(merged).catch((e:any)=>({ error: String(e) }));
    console.log('Legacy rebuild simulation result:', JSON.stringify(sim, null, 2));

    // Attempt 2: call RPC simulateTransaction providing the address lookup table accounts
    try{
      const lookupValues: any[] = [];
      for(const l of vt.message.addressTableLookups || []){
        try{
          const lookupPub = new PublicKey(l.accountKey || l.account);
          const resp:any = await connection.getAddressLookupTable(lookupPub);
          if(resp && resp.value) {
            // safe-clone resp.value converting BigInt -> string for JSON serialization
            const safe = JSON.parse(JSON.stringify(resp.value, (_k:any, v:any)=> (typeof v === 'bigint') ? v.toString() : v));
            lookupValues.push(safe);
          }
          else console.log('Empty lookup table response for', lookupPub.toBase58());
        }catch(e){ console.log('getAddressLookupTable failed for', JSON.stringify(l), String(e)); }
      }
      if(lookupValues.length===0){ console.log('No lookup table accounts to attach for RPC simulate.'); }
      const args = [ swapB64, { encoding: 'base64', commitment: 'confirmed', addressLookupTableAccounts: lookupValues } ];
      console.log('Calling RPC simulateTransaction with', lookupValues.length, 'lookup tables');
      const raw: any = await connection._rpcRequest('simulateTransaction', args);
      console.log('RPC simulateTransaction raw result:', JSON.stringify(raw && raw.result ? raw.result : raw, null, 2));
    }catch(e3){ console.log('RPC simulate with lookup tables failed:', String(e3)); }
  }catch(e){ console.error('Error in rebuild/simulate:', e); process.exit(2); }
}

main();
