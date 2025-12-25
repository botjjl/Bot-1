require('dotenv').config();
import fs from 'fs';
import path from 'path';
const sniper = require('../sniper.js');
const { unifiedBuy, unifiedSell } = require('../src/tradeSources');

async function main(){
  console.log('Live buy (0.005 SOL) + immediate sell starting...');
  const pkEnv = process.env.PRIVATE_KEY;
  if(!pkEnv){ console.error('PRIVATE_KEY not set in .env'); process.exit(1); }
  let secret:any = null;
  try{ secret = JSON.parse(pkEnv); }catch(_e){ secret = pkEnv; }

  const tokens = await sniper.collectFreshMints({ maxCollect: 1, timeoutMs: 60000 }).catch((e:any)=>{ console.error('collectFreshMints failed', e); return []; });
  if(!tokens || tokens.length===0){ console.error('No fresh mints found'); process.exit(1); }
  const tok = tokens[0];
  const mint = tok.mint || tok.tokenAddress || tok.address;
  console.log('Collected token:', mint);

  // Force mask/flags to ensure immediate sell triggers
  tok.ledgerMask = tok.ledgerMask || ((1 << 6) | (1 << 13));
  tok.ledgerStrong = true;
  tok.solletCreatedHere = true;

  const buyAmount = 0.005;
  console.log(`Attempting unifiedBuy(${mint}, ${buyAmount}) with bot wallet`);
  let buyRes: any = null;
  try{
    buyRes = await unifiedBuy(mint, buyAmount, secret);
    console.log('Buy result:', buyRes);
  }catch(e){ console.error('Buy failed', e); process.exit(1); }
  // Immediately attempt sell: determine purchased token base-units from buy tx and use that
  try{
    const txSig = buyRes && (buyRes.tx || buyRes.raw && buyRes.raw.tx) || null;
    let sellRes: any = null;
    if(!txSig){ throw new Error('Could not determine buy tx signature to compute purchased amount'); }
    const { getConnection } = require('../src/wallet');
    const conn = getConnection();
    const tx = await conn.getTransaction(txSig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 } as any);
    // find postTokenBalances entry for our mint and our wallet
    const post = (tx && tx.meta && tx.meta.postTokenBalances) || [];
    let baseAmount: number | null = null;
    const myOwner = process.env.BOT_WALLET_ADDRESS;
    // Prefer the postTokenBalances entry owned by our bot wallet
    for(const p of post){
      try{
        if(p && p.mint === mint && p.owner === myOwner){
          const a = p.uiTokenAmount && p.uiTokenAmount.amount ? p.uiTokenAmount.amount : (p.amount || null);
          if(a) { baseAmount = Number(a); break; }
        }
      }catch(e){}
    }
    // Fallback: any entry matching the mint
    if(baseAmount === null){
      for(const p of post){
        try{
          if(p && p.mint === mint){
            const a = p.uiTokenAmount && p.uiTokenAmount.amount ? p.uiTokenAmount.amount : (p.amount || null);
            if(a) { baseAmount = Number(a); break; }
          }
        }catch(e){}
      }
    }
    if(!baseAmount){ throw new Error('Could not locate purchased token amount in buy tx'); }
    console.log(`Attempting unifiedSell(${mint}, baseUnits=${baseAmount}) with bot wallet`);
    sellRes = await unifiedSell(mint, baseAmount, secret);
    console.log('Sell result:', sellRes);
    // Summarize PnL: best-effort using returned raw data if available
    try{
      const buyTx = buyRes && (buyRes.tx || buyRes.raw && buyRes.raw.tx) || null;
      const sellTx = sellRes && (sellRes.tx || sellRes.raw && sellRes.raw.tx) || null;
      console.log('BuyTx:', buyTx, 'SellTx:', sellTx);
    }catch(_e){}
  }catch(e){ console.error('Sell failed', e); process.exit(1); }

  console.log('Live buy+sell script completed');
}

main().catch(e=>{ console.error(e); process.exit(1); });
