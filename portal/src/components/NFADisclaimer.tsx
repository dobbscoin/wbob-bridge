export function NFADisclaimer({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <p className="text-[10px] uppercase tracking-wider text-gray-500">
        NOT FINANCIAL ADVISORS · NOT FINANCIAL ADVICE
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-yellow-900/40 bg-yellow-950/20 px-4 py-3 text-xs text-yellow-200/80 text-center">
      <p className="font-semibold uppercase tracking-wider text-yellow-300">
        Not Financial Advisors. Not Financial Advice.
      </p>
      <p className="mt-1 text-yellow-200/60">
        (BOB) is not for sale. It is for trade. Anything you do here is your own
        decision — Praise &quot;Bob,&quot; but verify the contracts yourself.
      </p>
    </div>
  );
}
