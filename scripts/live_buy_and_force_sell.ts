require('dotenv').config();
import fs from 'fs';
import path from 'path';
const sniper = require('../sniper.js');
const { registerBuyWithTarget, monitorAndAutoSellTrades } = require('../src/bot/strategy');
const { unifiedBuy } = require('../src/tradeSources');
const { loadKeypair } = require('../src/wallet');

async function main(){
  console.log('Live buy + immediate mask-sell starting...');
  // Load PRIVATE_KEY from env
  const pkEnv = process.env.PRIVATE_KEY;
  if(!pkEnv){ console.error('PRIVATE_KEY not set in .env'); process.exit(1); }
  let secret:any = null;
  try{ secret = JSON.parse(pkEnv); }catch(_e){ secret = pkEnv; }

  const userId = String(process.env.TELEGRAM_USER_ID || 'bot_auto');
  const user: any = { id: userId, secret, wallet: process.env.BOT_WALLET_ADDRESS || null, strategy: { buyAmount: 0.01, sellPercent1: 100, enabled: true } };

  // Fetch one fresh mint
  const tokens = await sniper.collectFreshMints({ maxCollect: 1, timeoutMs: 20000 }).catch((e:any)=>{ console.error('collectFreshMints failed', e); return []; });
  if(!tokens || tokens.length===0){ console.error('No fresh mints found'); process.exit(1); }
  const tok = tokens[0];
  console.log('Collected token:', tok.mint || tok.address || tok.tokenAddress);

  // Force mask so immediate sell triggers
  tok.ledgerMask = tok.ledgerMask || ((1 << (6+0)) | (1 << (6+5)) );
  tok.ledgerStrong = true;
  tok.solletCreatedHere = true;

  // Do live buy
  const amount = 0.01;
  console.log(`Attempting unifiedBuy(${tok.mint}, ${amount}) with bot wallet`);
  try{
    const buyRes = await unifiedBuy(tok.mint, amount, secret);
    console.log('Buy result:', buyRes);
    registerBuyWithTarget(user, { address: tok.mint, price: tok.price || null }, buyRes, user.strategy.targetPercent || 10);
  }catch(e){ console.error('Buy failed', e); process.exit(1); }

  // Now call monitor to immediately execute sells (will perform real unifiedSell using same secret)
  try{
    await monitorAndAutoSellTrades(user, [ { address: tok.mint, ledgerMask: tok.ledgerMask, ledgerStrong: tok.ledgerStrong, solletCreatedHere: tok.solletCreatedHere, price: tok.price || 1, address: tok.mint } ]);
    console.log('monitorAndAutoSellTrades completed');
  }catch(e){ console.error('Monitor sell failed', e); }

  console.log('Done');
}

main().catch(e=>{ console.error(e); process.exit(1); });
