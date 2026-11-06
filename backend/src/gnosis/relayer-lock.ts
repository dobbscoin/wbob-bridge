/**
 * Serializes transactions sent from the relayer (executor) key within this
 * process. The mint executor and the V2 refund recorder both send from it on
 * independent loops; two concurrent sends would fetch the same pending nonce
 * and one would fail ("nonce too low" / "replacement underpriced").
 * Wrap only the SEND (nonce fetch + broadcast), not the receipt wait.
 */
let tail: Promise<unknown> = Promise.resolve();

export function withRelayerLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
