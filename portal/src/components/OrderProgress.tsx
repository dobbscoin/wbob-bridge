'use client';

import { INBOUND_STEPS, OUTBOUND_STEPS, stateIndex } from '@/lib/contracts';
import type { OrderResponse } from '@/lib/api';

const ERROR_STATES = new Set(['FAILED', 'MANUAL_REVIEW', 'REFUNDED']);

interface Props {
  order: OrderResponse;
}

export function OrderProgress({ order }: Props) {
  const isOutbound = order.orderType === 'outbound';
  const steps = isOutbound ? OUTBOUND_STEPS : INBOUND_STEPS;
  const currentIdx = stateIndex(order.state, isOutbound);
  const isError = ERROR_STATES.has(order.state);
  const isDone = order.state === 'COMPLETED';

  return (
    <ol className="relative border-l border-gray-700 ml-3 space-y-6">
      {steps.map((step, i) => {
        const done    = isDone ? true : i < currentIdx;
        const active  = !isError && i === currentIdx;
        const pending = !done && !active;

        return (
          <li key={step.state} className="ml-6">
            {/* Circle marker */}
            <span className={`
              absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-gray-950
              ${done    ? 'bg-bob-500'  : ''}
              ${active  ? 'bg-bob-400 animate-pulse' : ''}
              ${pending ? 'bg-gray-700' : ''}
              ${isError && active ? 'bg-red-500 animate-none' : ''}
            `}>
              {done && (
                <svg className="h-3 w-3 text-gray-950" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/>
                </svg>
              )}
            </span>

            <p className={`text-sm font-medium leading-none
              ${done    ? 'text-bob-400' : ''}
              ${active  ? 'text-white'   : ''}
              ${pending ? 'text-gray-500': ''}
            `}>
              {step.label}
            </p>

            {/* Extra detail for confirming state */}
            {active && order.confirmations !== null && !isOutbound && (
              <p className="mt-1 text-xs text-gray-400">
                {order.confirmations} / 6 confirmations
              </p>
            )}
          </li>
        );
      })}

      {isError && (
        <li className="ml-6">
          <span className="absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-gray-950 bg-red-600">
            <svg className="h-3 w-3 text-white" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/>
            </svg>
          </span>
          <p className="text-sm font-medium text-red-400">
            {order.state === 'MANUAL_REVIEW' ? 'Requires manual review — contact support' : 'Order failed'}
          </p>
        </li>
      )}
    </ol>
  );
}
