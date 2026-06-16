import { createPublicClient, http, fallback } from 'viem';
import { appChain, appRpcUrl, appRpcFallback } from '@/config/chain';

export const publicClient = createPublicClient({
  chain: appChain,
  transport: fallback([
    http(appRpcUrl,      { timeout: 20_000 }),
    http(appRpcFallback, { timeout: 20_000 }),
  ]),
});
