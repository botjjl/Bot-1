require('dotenv').config();
// Sell all non-zero token accounts owned by BOT_WALLET_ADDRESS using unifiedSell
import { PublicKey } from '@solana/web3.js';
const { unifiedSell } = require('../src/tradeSources');
const { getConnection, loadKeypair } = require('../src/wallet');

async function main(){
  const live = String(process.env.LIVE_TRADES || '').toLowerCase() === 'true';
  const confirm = String(process.env.CONFIRM_SEND || '').toLowerCase() === 'yes';
  if(!live || !confirm){
    console.error('Safety: LIVE_TRADES=true and CONFIRM_SEND=yes required to perform real sells.');
    console.error('Set env and re-run if you want to execute real sells.');
    process.exit(1);
  }

  const pkEnv = process.env.PRIVATE_KEY;
  if(!pkEnv){ console.error('PRIVATE_KEY not set'); process.exit(1); }
  let secret: any = null;
  try{ secret = JSON.parse(pkEnv); }catch(e){ secret = pkEnv; }

  const ownerAddr = process.env.BOT_WALLET_ADDRESS;
  if(!ownerAddr){ console.error('BOT_WALLET_ADDRESS not set'); process.exit(1); }

  const conn = getConnection();
  const owner = new PublicKey(ownerAddr);

  console.log('Fetching token accounts for', ownerAddr);
  const resp = await conn.getParsedTokenAccountsByOwner(owner, { programId: require('@solana/spl-token').TOKEN_PROGRAM_ID });
  const accounts = resp.value || [];
  if(accounts.length===0){ console.log('No token accounts found'); return; }

  for(const a of accounts){
    try{
      const info = a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info;
      if(!info) continue;
      const mint = info.mint;
      const amt = info.tokenAmount && info.tokenAmount.amount ? Number(info.tokenAmount.amount) : 0;
      const ui = info.tokenAmount && info.tokenAmount.uiAmount || 0;
      if(amt <= 0) continue;
      // Skip native wrapped SOL mint (handle separately if desired)
      if(mint === 'So11111111111111111111111111111111111111112'){
        console.log('Skipping wSOL token account:', a.pubkey.toString(), 'mint', mint, 'ui', ui);
        continue;
      }
      console.log(`Selling mint ${mint} from tokenAccount ${a.pubkey.toString()} — amount (base units) ${amt} (ui ${ui})`);
      const res = await unifiedSell(mint, amt, secret);
      console.log('Sell result for', mint, res && (res.tx || res.signature || JSON.stringify(res)));
      // small delay to avoid hitting RPC/Jupiter rate limits
      await new Promise(r=>setTimeout(r, 1200));
    }catch(e){ console.error('Sell failed for account', a.pubkey && a.pubkey.toString(), e); }
  }
  console.log('Done selling current token accounts');
}

main().catch(e=>{ console.error(e); process.exit(1); });
