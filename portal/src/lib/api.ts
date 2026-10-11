const BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3000';

export interface QuoteResponse {
  orderId:        string;
  depositAddress: string;
  amountSat:      string;
  expiresAt:      string;
}

export type RefundState = 'queued' | 'broadcast' | 'confirmed' | 'needs_attention' | 'too_small';

/** Refund still moving — keep polling the order while this is true. */
export function refundInFlight(o: Pick<OrderResponse, 'refundState'>): boolean {
  return o.refundState === 'queued' || o.refundState === 'broadcast';
}

export interface OrderResponse {
  orderId:              string;
  state:                string;
  orderType:            string;
  recipientAddress:     string | null;
  amountSat:            string | null;
  depositAddress:       string | null;
  depositId:            string | null;
  txid:                 string | null;
  vout:                 number | null;
  confirmations:        number | null;
  gnosisTxHash:         string | null;
  // Outbound-specific (null for inbound):
  burnTxHash:           string | null;
  payoutTxid:           string | null;
  payoutConfirmations:  number | null;
  // Inbound daily-cap split (null when it does not apply / not decided yet):
  depositedSat:         string | null;   // what arrived on Dobbscoin
  mintedSat:            string | null;   // what is minted as wBOB ("0" = refunded whole)
  refundSat:            string | null;   // over today's cap, owed back to the sender (before fee)
  refundSentSat:        string | null;   // what the refund pays the sender (after network fee)
  refundFeeSat:         string | null;
  refundAddress:        string | null;   // the deposit's sending address
  refundTxid:           string | null;   // set once broadcast
  refundState:          RefundState | null;
  refundConfirmations:  number | null;
  expiresAt:            string | null;
  createdAt:            string;
  updatedAt:            string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function createQuote(recipientAddress: string, amountSat: string): Promise<QuoteResponse> {
  return api<QuoteResponse>('/v1/quotes', {
    method: 'POST',
    body: JSON.stringify({ recipientAddress, amountSat }),
  });
}

export function getOrder(orderId: string): Promise<OrderResponse> {
  return api<OrderResponse>(`/v1/orders/${orderId}`);
}

export function getOrderByWithdrawal(withdrawalId: string): Promise<{ orderId: string }> {
  return api<{ orderId: string }>(`/v1/orders/by-withdrawal/${withdrawalId}`);
}

export interface DepositAddressResponse {
  recipientAddress: string;
  depositAddress:   string;
  sourceChainName:  string;
  hdIndex:          number;
  createdAt:        string;
}

export function getDepositAddress(
  recipient: string,
  optInDrip: boolean = true,
): Promise<DepositAddressResponse> {
  const optInParam = optInDrip ? 'true' : 'false';
  return api<DepositAddressResponse>(
    `/v1/deposit-address?recipient=${recipient}&optInDrip=${optInParam}`,
  );
}

export function listOrdersByRecipient(recipient: string, limit = 50): Promise<{ orders: OrderResponse[] }> {
  return api<{ orders: OrderResponse[] }>(`/v1/orders?recipient=${recipient}&limit=${limit}`);
}

// ─── Gas drip ────────────────────────────────────────────────────────────────

export type DripStatus =
  | 'opted_in'
  | 'opted_out'
  | 'sent'
  | 'failed'
  | 'wallet_dry'
  | 'recipient_has_gas'   // skipped: wallet already had xDAI; still eligible on a later mint
  | 'no_record';

export interface DripStatusResponse {
  enabled: boolean;
  recipient: string;
  status: DripStatus;
  amountWei: string | null;
  gnosisTxHash: string | null;
  sentAt: string | null;
  /** xDAI (wei) the wallet held when the drip was skipped (status recipient_has_gas). */
  recipientBalanceWei?: string | null;
}

export function getDripStatus(recipient: string): Promise<DripStatusResponse> {
  return api<DripStatusResponse>(`/v1/drip/${recipient}`);
}

// ─── Daily mint cap ──────────────────────────────────────────────────────────

export interface MintCapResponse {
  limitSat:       string;
  mintedTodaySat: string;   // executed on-chain in the current window
  reservedSat:    string;   // authorized by the bridge, not yet executed
  remainingSat:   string;   // what the next deposit can mint: limit − minted − reserved
  windowStale:    boolean;
  windowStart:    string;
  resetsAt:       string;   // ISO, 00:00 UTC
  gnosisBlock:    string;
  checkedAt:      string;
}

export function getMintCap(): Promise<MintCapResponse> {
  return api<MintCapResponse>('/v1/mint-cap');
}
