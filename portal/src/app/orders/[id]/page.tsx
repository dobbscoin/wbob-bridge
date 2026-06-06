'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getOrder } from '@/lib/api';
import { satsToBob, shortHash, gnosisExplorerTx } from '@/lib/utils';
import { OrderProgress } from '@/components/OrderProgress';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'MANUAL_REVIEW', 'REFUNDED']);

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();

  const { data: order, isLoading, error } = useQuery({
    queryKey: ['order', id],
    queryFn: () => getOrder(id),
    enabled: !!id,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state && TERMINAL.has(state) ? false : 12_000;
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-500 animate-pulse">Loading order…</p>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="mx-auto max-w-lg">
        <div className="card text-center space-y-3">
          <p className="text-red-400 font-medium">Order not found</p>
          <p className="text-sm text-gray-500">
            {error instanceof Error ? error.message : `No order with ID: ${id}`}
          </p>
          <a href="/" className="text-sm text-bob-400 hover:underline">← Back to bridge</a>
        </div>
      </div>
    );
  }

  const isOutbound = order.orderType === 'outbound';

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          {isOutbound ? 'Withdrawal' : 'Deposit'} Order
        </h1>
        <span className={`text-xs px-2 py-1 rounded-full font-medium
          ${order.state === 'COMPLETED'     ? 'bg-bob-500/20 text-bob-300' : ''}
          ${order.state === 'FAILED'        ? 'bg-red-500/20 text-red-400' : ''}
          ${order.state === 'MANUAL_REVIEW' ? 'bg-orange-500/20 text-orange-400' : ''}
          ${!['COMPLETED','FAILED','MANUAL_REVIEW'].includes(order.state) ? 'bg-gray-700 text-gray-300' : ''}
        `}>
          {order.state.replace(/_/g, ' ')}
        </span>
      </div>

      {/* Progress */}
      <div className="card space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Progress</h2>
        <OrderProgress order={order} />
      </div>

      {/* Details */}
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Details</h2>

        <DetailRow label="Amount">
          {order.amountSat ? `${satsToBob(order.amountSat)} ${isOutbound ? 'wBOB → BOB' : 'BOB → wBOB'}` : '—'}
        </DetailRow>

        {!isOutbound && order.depositAddress && (
          <DetailRow label="Deposit address">
            <code className="text-xs font-mono text-bob-300 break-all">{order.depositAddress}</code>
          </DetailRow>
        )}

        {!isOutbound && order.txid && (
          <DetailRow label="Dobbscoin txid">
            <code className="text-xs font-mono text-gray-300">{shortHash(order.txid, 12)}</code>
          </DetailRow>
        )}

        {!isOutbound && order.confirmations !== null && (
          <DetailRow label="Confirmations">
            {order.confirmations} / 60
          </DetailRow>
        )}

        {order.gnosisTxHash && (
          <DetailRow label="Gnosis tx">
            <a
              href={gnosisExplorerTx(order.gnosisTxHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-bob-400 hover:underline text-sm font-mono"
            >
              {shortHash(order.gnosisTxHash, 10)} ↗
            </a>
          </DetailRow>
        )}

        <DetailRow label="Order ID">
          <code className="text-xs font-mono text-gray-500">{order.orderId}</code>
        </DetailRow>

        <DetailRow label="Created">
          {new Date(order.createdAt).toLocaleString()}
        </DetailRow>

        {order.expiresAt && (
          <DetailRow label="Expires">
            {new Date(order.expiresAt).toLocaleString()}
          </DetailRow>
        )}
      </div>

      <a href="/" className="text-sm text-gray-500 hover:text-gray-300 flex items-center gap-1">
        ← Back to bridge
      </a>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-gray-500 shrink-0">{label}</span>
      <span className="text-gray-200 text-right">{children}</span>
    </div>
  );
}
