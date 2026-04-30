'use client';

import { useState } from 'react';
import { shortHash } from '@/lib/utils';

export function CopyAddress({
  address,
  label,
  className = '',
}: {
  address: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onClick = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={`Copy ${label ?? 'address'}: ${address}`}
      className={`inline-flex items-center gap-1.5 rounded-md border border-bob-700/40 bg-bob-500/10 px-2 py-0.5 font-mono text-bob-200 hover:border-bob-500/80 hover:bg-bob-500/20 transition-colors ${className}`}
    >
      <span>{shortHash(address, 6)}</span>
      <span className="text-bob-400" aria-hidden>
        {copied ? '✓' : '⧉'}
      </span>
      <span className="sr-only">{copied ? 'Copied' : 'Click to copy'}</span>
    </button>
  );
}
