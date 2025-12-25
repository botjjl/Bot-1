#!/usr/bin/env ts-node
import { unifiedBuyAndSellBatch } from '../src/tradeSources';
const { loadKeypair } = require('../src/wallet');

async function main(){
  const secret = process.env.BOT_SECRET || process.env.BOT_KEYPAIR || '';
  if(!secret) { console.error('Set BOT_SECRET (base64) to a keypair for testing'); process.exit(1); }
  const kp = loadKeypair(secret);
  const walletAdapter:any = {
    publicKey: kp.publicKey,
    async signTransaction(tx:any){ tx.sign(kp); return tx; },
    async signAllTransactions(txs:any[]){ txs.forEach(t=>t.sign(kp)); return txs; }
  };
  const tokenMint = process.env.TEST_TOKEN_MINT || '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj';
  const buySol = Number(process.env.TEST_BUY_SOL || '0.005');
  try{
    const res = await unifiedBuyAndSellBatch(walletAdapter, tokenMint, buySol, undefined, { simulateOnly: true, atomic: true, createAtaBeforeSell: true, reverseOrder: true });
    console.log('Batch buy+sell (simulate-only) results:');
    console.log(JSON.stringify(res, null, 2));
  }catch(e){ console.error('Error running batch test:', e); process.exit(2); }
}

main();
