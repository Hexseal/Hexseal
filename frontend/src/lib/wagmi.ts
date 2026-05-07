import { createPublicClient, http } from 'viem';
import { appChain, appRpcUrl } from '@/config/chain';

export const publicClient = createPublicClient({
  chain: appChain,
  transport: http(appRpcUrl),
});
