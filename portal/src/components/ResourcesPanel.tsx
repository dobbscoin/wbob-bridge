'use client';

type ResourceLink = {
  href: string;
  label: string;
  sub: string;
};

const RESOURCES: ResourceLink[] = [
  { href: 'https://subgenius.finance/',                                         label: 'SubGenius.Finance', sub: 'Where SubCulture\nBecomes Capital'       },
  { href: 'https://dobbscoin.info/',                                            label: 'Dobbscoin.info',    sub: 'Backed by NOTHING,\nPowered by Everything'},
  { href: 'https://explorer.dobbscoin.info/',                                   label: 'Explorer',          sub: 'Where They At?'                          },
  { href: 'https://pool.dobbscoin.info/',                                       label: 'Mining Pool',       sub: 'Get Slack NOW,\nWhile Difficulty is LOW' },
  { href: 'https://github.com/dobbscoin/dobbscoin-source/releases',             label: 'Full Node',         sub: 'Full Node Wallet'                        },
  { href: 'https://github.com/dobbscoin/dobbscoin-source/releases/tag/v0.10.1', label: 'Qt Wallet',         sub: 'Windows Dobbscoin Client'                },
  { href: 'https://github.com/dobbscoin/dobbscoin-source',                      label: 'GitHub REPO',       sub: 'Daemon + Qt repo'                        },
  { href: 'https://subgenius.vip/dobbscoin.apk',                                label: 'Android Wallet',    sub: '.apk download'                           },
  { href: 'https://dobbscoin.info/faucet',                                      label: 'FAUCET',            sub: 'Something 4 Nothing'                     },
];

export function ResourcesPanel() {
  return (
    <aside className="card space-y-3">
      <h3 className="text-xs font-bold uppercase tracking-widest text-bob-300">
        Beyond the Bridge
      </h3>
      <ul className="space-y-2">
        {RESOURCES.map((r) => (
          <li key={`${r.label}-${r.href}`}>
            <a
              href={r.href}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-md border border-gray-700 bg-gray-800/80 px-3 py-2 hover:border-bob-500/80 hover:bg-gray-800 transition-colors"
            >
              <p className="text-sm font-semibold text-white">
                {r.label} <span className="text-bob-400">↗</span>
              </p>
              <p className="text-[10px] leading-snug text-gray-400 whitespace-pre-line break-words">{r.sub}</p>
            </a>
          </li>
        ))}
      </ul>
      <p className="border-t border-gray-700 pt-2 text-xs text-gray-300">
        External — not bridge resources. Verify links yourself.
      </p>
    </aside>
  );
}
