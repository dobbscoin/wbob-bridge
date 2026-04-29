import { WBOB_ADDRESS } from './contracts';

export const GNOSIS_CHAIN_ID_HEX = '0x64';

export const WXDAI_ADDRESS =
  '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d' as const;

export const WBOB_LOGO_URI =
  'https://raw.githubusercontent.com/1Hive/default-token-list/master/src/assets/gnosis/0x13550ae65f22a36f60a50d625b70b58666488263/logo.png';

export const WXDAI_LOGO_URI =
  'https://assets.coingecko.com/coins/images/14584/standard/wrapped-xdai-logo.png';

const GNOSIS_CHAIN_PARAMS = {
  chainId: GNOSIS_CHAIN_ID_HEX,
  chainName: 'Gnosis',
  nativeCurrency: { name: 'xDAI', symbol: 'XDAI', decimals: 18 },
  rpcUrls: [
    'https://rpc.gnosischain.com',
    'https://gnosis-rpc.publicnode.com',
  ],
  blockExplorerUrls: ['https://gnosisscan.io'],
};

type EthProvider = {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
};

function getProvider(): EthProvider | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { ethereum?: EthProvider };
  return w.ethereum ?? null;
}

export async function addGnosisChain(): Promise<'added' | 'no-provider' | 'rejected'> {
  const provider = getProvider();
  if (!provider) return 'no-provider';
  try {
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [GNOSIS_CHAIN_PARAMS],
    });
    return 'added';
  } catch {
    return 'rejected';
  }
}

export async function switchToGnosis(): Promise<'switched' | 'added' | 'no-provider' | 'rejected'> {
  const provider = getProvider();
  if (!provider) return 'no-provider';
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: GNOSIS_CHAIN_ID_HEX }],
    });
    return 'switched';
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 4902 || code === -32603) {
      const result = await addGnosisChain();
      return result === 'added' ? 'added' : result;
    }
    return 'rejected';
  }
}

async function watchAsset(opts: {
  address: string;
  symbol: string;
  decimals: number;
  image?: string;
}): Promise<'added' | 'no-provider' | 'rejected'> {
  const provider = getProvider();
  if (!provider) return 'no-provider';
  try {
    await provider.request({
      method: 'wallet_watchAsset',
      params: {
        type: 'ERC20',
        options: opts,
      },
    });
    return 'added';
  } catch {
    return 'rejected';
  }
}

export function addWBobToken() {
  if (!WBOB_ADDRESS) return Promise.resolve<'no-provider'>('no-provider');
  return watchAsset({
    address: WBOB_ADDRESS,
    symbol: 'wBOB',
    decimals: 8,
    image: WBOB_LOGO_URI,
  });
}

export function addWxdaiToken() {
  return watchAsset({
    address: WXDAI_ADDRESS,
    symbol: 'WXDAI',
    decimals: 18,
    image: WXDAI_LOGO_URI,
  });
}
