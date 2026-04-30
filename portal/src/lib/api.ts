const BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3000';

export interface QuoteResponse {
  orderId:        string;
  depositAddress: string;
  amountSat:      string;
  expiresAt:      string;
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
  | 'no_record';

export interface DripStatusResponse {
  enabled: boolean;
  recipient: string;
  status: DripStatus;
  amountWei: string | null;
  gnosisTxHash: string | null;
  sentAt: string | null;
}

export function getDripStatus(recipient: string): Promise<DripStatusResponse> {
  return api<DripStatusResponse>(`/v1/drip/${recipient}`);
}
