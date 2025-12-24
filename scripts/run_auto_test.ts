import { readFileSync } from 'fs';
import { autoExecuteStrategyForUser } from '../src/autoStrategyExecutor';

async function main(){
  const users = JSON.parse(readFileSync('./users.json','utf8'));
  const userId = Object.keys(users)[0];
  const user = users[userId];
  user.id = userId;
  console.log('Testing autoExecute for user', userId);
  // sample token without merged signal
  const tokens = [ { mint: 'TEST_MINT_NO_SIGNAL', ledgerMask: 0, mergedSignal: false } ];
  const res = await autoExecuteStrategyForUser(user, tokens, 'buy', { simulateOnly: false, listenerBypass: true });
  console.log('Result:', JSON.stringify(res, null, 2));

  // Now test simulation mode with a token that has mergedSignal but user lacks secret
  const tokensSim = [ { mint: 'TEST_MINT_MERGED', ledgerMask: 3, mergedSignal: true } ];
  const resSim = await autoExecuteStrategyForUser(user, tokensSim, 'buy', { simulateOnly: true, listenerBypass: true });
  console.log('Sim Result:', JSON.stringify(resSim, null, 2));
}

main().catch(e=>{ console.error(e); process.exit(1); });
