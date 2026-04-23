import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { gnosis } from 'wagmi/chains';

export const wagmiConfig = getDefaultConfig({
  appName: 'wBOB Bridge',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'placeholder',
  chains: [gnosis],
  ssr: true,
});
