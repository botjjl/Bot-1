#!/usr/bin/env ts-node
import { createJupiterApiClient } from '@jup-ag/api';
const rpcPool = require('../src/utils/rpcPool').default;
const { loadKeypair, generateKeypair } = require('../src/wallet');
const fs = require('fs');
const { VersionedTransaction, Transaction, PublicKey } = require('@solana/web3.js');

async function main(){
  // Accept a keypair via `BOT_SECRET` (base64/JSON) or `BOT_KEYPAIR_PATH` (file path).
  // If neither is provided, generate an ephemeral keypair (useful for inspection without secrets).
  const secretEnv = process.env.BOT_SECRET || process.env.BOT_KEYPAIR;
  const keypath = process.env.BOT_KEYPAIR_PATH;
  let kp:any;
  let ephemeral = false;
  if (secretEnv) {
    kp = loadKeypair(secretEnv);
  } else if (keypath) {
    try{
      const content = fs.readFileSync(keypath, 'utf8').trim();
      kp = loadKeypair(content);
    }catch(e){ console.error('Failed to load keypair from BOT_KEYPAIR_PATH:', keypath, e); process.exit(1); }
  } else {
    kp = generateKeypair();
    ephemeral = true;
    console.log('No key provided; using generated ephemeral keypair:', kp.publicKey.toBase58());
  }
  const tokenMint = process.env.TEST_TOKEN_MINT || '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj';
  const buySol = Number(process.env.TEST_BUY_SOL || '0.005');
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const jupiter = createJupiterApiClient();
  const userPublicKey = kp.publicKey.toBase58();
  try{
    const buyAmountLamports = Math.floor(buySol * 1e9);
    const buyQuote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: tokenMint, amount: buyAmountLamports, slippageBps: Number(process.env.JUPITER_SLIPPAGE_BPS || '30') });
    console.log('\nBUY quote.routePlan:');
    try{ console.log(JSON.stringify(buyQuote.routePlan, null, 2).slice(0, 20000)); }catch(e){ console.log('Could not stringify buy routePlan', e); }
    if(!buyQuote || !buyQuote.routePlan) throw new Error('No buy route');
    // build buy swap to get actual out amount
    const buySwapResp = await jupiter.swapPost({ swapRequest: { userPublicKey, wrapAndUnwrapSol: true, asLegacyTransaction: false, quoteResponse: buyQuote } });
    const buyBuf = Buffer.from(buySwapResp.swapTransaction, 'base64');
    // simulate locally via RPC to get actual out amount (skip if ephemeral keypair)
    const connection = rpcPool.getRpcConnection();
    let extractedOutAmount = 0;
    if (!ephemeral) {
      try{
        let txObj:any;
        try { txObj = VersionedTransaction.deserialize(buyBuf); } catch(_){ txObj = Transaction.from(buyBuf); }
        const sim = await connection.simulateTransaction(txObj).catch(()=>null);
        if(sim && sim.value && sim.value.postTokenBalances){
          for(const p of sim.value.postTokenBalances){ if(p.mint === tokenMint && p.owner === userPublicKey){ extractedOutAmount = Number(p.amount || p.uiTokenAmount?.amount || 0); break; } }
        }
      }catch(_){ }
    } else {
      console.log('Ephemeral keypair: skipping buy simulation. Falling back to quote outAmount.');
    }

    const sellAmountForQuote = (extractedOutAmount && extractedOutAmount>0) ? Math.floor(Number(extractedOutAmount)) : Math.floor(Number(buyQuote.outAmount || 0));
    const sellQuote = await jupiter.quoteGet({ inputMint: tokenMint, outputMint: SOL_MINT, amount: sellAmountForQuote, slippageBps: Number(process.env.JUPITER_SLIPPAGE_BPS || '30') });
    console.log('\nSELL quote.routePlan:');
    try{ console.log(JSON.stringify(sellQuote.routePlan, null, 2).slice(0, 20000)); }catch(e){ console.log('Could not stringify sell routePlan', e); }
    if(!sellQuote || !sellQuote.routePlan) throw new Error('No sell route');
    const sellSwapResp = await jupiter.swapPost({ swapRequest: { userPublicKey, wrapAndUnwrapSol: true, asLegacyTransaction: false, quoteResponse: sellQuote } });
    console.log('\nSELL swapPost response:');
    try{ console.log(JSON.stringify(sellSwapResp, null, 2).slice(0, 20000)); }catch(e){ console.log('Could not stringify sellSwapResp', e); }
    if(!sellSwapResp || !sellSwapResp.swapTransaction) throw new Error('No sell swapTransaction');
    const swapB64 = sellSwapResp.swapTransaction;
    console.log('SELL swapTransaction (base64):', swapB64);
    const swapBuf = Buffer.from(swapB64,'base64');
    try{
      const vt = VersionedTransaction.deserialize(swapBuf);
      console.log('\nDetected VersionedTransaction. Message info:');
      try{
        console.log('header:', vt.message.header || null);
        console.log('static accountKeys length:', (vt.message.accountKeys && vt.message.accountKeys.length) || 0);
        console.log('addressTableLookups count:', (vt.message.addressTableLookups && vt.message.addressTableLookups.length) || 0);
      }catch(kErr){ console.log('Could not read message fields:', String(kErr)); }
      console.log('\nResolving address lookup tables and mapping compiled instructions to full account keys...');
      try{
        // Build full account list: static accountKeys + addresses from lookup tables (in order)
        const staticKeys = vt.message.accountKeys ? vt.message.accountKeys.map((k:any)=> (k.toBase58 ? k.toBase58() : String(k))) : [];
        const lookups = vt.message.addressTableLookups || [];
        const resolvedExtra: string[] = [];
        for(const l of lookups){
          try{
            const lookupPub = new PublicKey(l.accountKey || l.account); // field name may vary
            const resp:any = await connection.getAddressLookupTable(lookupPub);
            const addrs = resp && resp.value && resp.value.state && resp.value.state.addresses ? resp.value.state.addresses : resp && resp.value && resp.value.addresses ? resp.value.addresses : [];
            const addrsStr = (addrs||[]).map((a:any)=> (a.toBase58 ? a.toBase58() : String(a)));
            resolvedExtra.push(...addrsStr);
            console.log('Resolved lookup', lookupPub.toBase58(), '->', addrsStr.length, 'addresses');
          }catch(lerr){ console.log('Lookup fetch failed for', JSON.stringify(l), String(lerr)); }
        }
        const fullKeys = staticKeys.concat(resolvedExtra);
        console.log('\nFull account keys count:', fullKeys.length);
        // Map compiled instructions
        const ci = vt.message.compiledInstructions || [];
        const mapped = ci.map((c:any, idx:number)=>({
          idx,
          programId: fullKeys[c.programIdIndex] || `idx:${c.programIdIndex}`,
          accounts: (c.accounts||[]).map((ai:number)=> ({ index: ai, key: fullKeys[ai] || `idx:${ai}` })),
          dataLen: c.data?.length || 0
        }));
        console.log(JSON.stringify(mapped, null, 2));
      }catch(ciErr){ console.log('Could not resolve compiledInstructions:', String(ciErr)); }
    }catch(_){
      try{
        const legacy = Transaction.from(swapBuf);
        console.log('\nDetected legacy Transaction. Program IDs and instruction keys:');
        for(const ix of legacy.instructions){
          console.log('ProgramId:', ix.programId.toBase58());
          console.log('Accounts:', ix.keys.map((k:any)=>({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })) );
          console.log('Data (hex):', ix.data.toString('hex').slice(0,200));
          console.log('---');
        }
      }catch(e){ console.error('Failed to deserialize transaction as legacy:', e); }
    }
  }catch(e){ console.error('Inspect failed:', e); process.exit(2); }
}

main();
