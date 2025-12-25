// @ts-nocheck
require('dotenv').config();
const buySig = process.env.LAST_BUY_TX || '5bJBMNYazXVPSbfzaP4GTz8c3e5eG9VuPJGW2cKJH7dz8LeYbNeQuznsc7ijAqr8Tj1oNsHizSojrBRHTjokeJ9b';
const sellSig = process.env.LAST_SELL_TX || '2y4qSwZGi34VUG4h6WELqvDq2sqv9psnmwGYYhtdY2UfQq3pHMNPg3h5hxgpPcctzjMUGmumvQT7eQrQU5egTPfu';
const wallet = process.env.BOT_WALLET_ADDRESS;
const rpcPool = require('../src/utils/rpcPool');
const conn = rpcPool.getRpcConnection();

(async function(){
  console.error('Bot wallet', wallet);
  const txB = await conn.getTransaction(buySig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const txS = await conn.getTransaction(sellSig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  function extract(tx){
    if(!tx) return null;
    return {
      accountKeys: tx.transaction && tx.transaction.message && (tx.transaction.message.accountKeys || tx.transaction.message.staticAccountKeys) || [],
      preBalances: tx.meta && tx.meta.preBalances || [],
      postBalances: tx.meta && tx.meta.postBalances || [],
      preToken: tx.meta && tx.meta.preTokenBalances || [],
      postToken: tx.meta && tx.meta.postTokenBalances || [],
    };
  }
  const EB = extract(txB);
  const ES = extract(txS);
  try{
    console.error('\nBUY accountKeys:', EB && EB.accountKeys && EB.accountKeys.slice(0,12).map(k=>String(k)));
  }catch(e){ console.error('Could not stringify accountKeys', e); }
  console.error('BUY accountKeys length:', EB && EB.accountKeys && EB.accountKeys.length);
  try{
    console.error('BUY message keys:', txB && txB.transaction && Object.keys(txB.transaction.message || {}));
  }catch(e){}
  try{
    console.error('BUY staticAccountKeys:', txB && txB.transaction && txB.transaction.message && txB.transaction.message.staticAccountKeys && txB.transaction.message.staticAccountKeys.map(k=>String(k)));
  }catch(e){}
  function findIndex(keys, addr){ if(!keys) return -1; for(let i=0;i<keys.length;i++){ if(String(keys[i]).toLowerCase()===String(addr).toLowerCase()) return i; } return -1; }
  const idxB = EB ? findIndex(EB.accountKeys, wallet) : -1;
  const idxS = ES ? findIndex(ES.accountKeys, wallet) : -1;
  console.error('buy wallet index', idxB, 'sell wallet index', idxS);
  const solDeltaBuy = (idxB>=0 && EB) ? (EB.postBalances[idxB] - EB.preBalances[idxB]) / 1e9 : null;
  const solDeltaSell = (idxS>=0 && ES) ? (ES.postBalances[idxS] - ES.preBalances[idxS]) / 1e9 : null;

  console.log('\n--- BUY TX ---', buySig);
  console.log('preBalances', EB && EB.preBalances);
  console.log('postBalances', EB && EB.postBalances);
  console.log('postTokenBalances', EB && EB.postToken);
  console.error('buy SOL delta', solDeltaBuy);

  console.log('\n--- SELL TX ---', sellSig);
  try{
    console.error('SELL message keys:', txS && txS.transaction && Object.keys(txS.transaction.message || {}));
  }catch(e){}
  try{
    console.error('SELL staticAccountKeys:', txS && txS.transaction && txS.transaction.message && txS.transaction.message.staticAccountKeys && txS.transaction.message.staticAccountKeys.map(k=>String(k)));
  }catch(e){}
  console.log('preBalances', ES && ES.preBalances);
  console.log('postBalances', ES && ES.postBalances);
  console.log('postTokenBalances', ES && ES.postToken);
  console.error('sell SOL delta', solDeltaSell);

  if(solDeltaBuy!==null && solDeltaSell!==null){
    const net = solDeltaSell + solDeltaBuy;
    console.error('\nNet SOL PnL (sell + buy delta):', net, 'SOL');
  } else {
    console.error('Could not compute net PnL (missing indices)');
  }
})();
