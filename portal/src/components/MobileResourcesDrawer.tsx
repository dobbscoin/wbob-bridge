'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ResourcesPanel } from './ResourcesPanel';

export function MobileResourcesDrawer() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Wait until after hydration before allowing the portal to render.
  useEffect(() => { setMounted(true); }, []);

  // Lock body scroll when drawer is open.
  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open resources menu"
        className="-ml-1 flex items-center gap-2 p-2 text-gray-400 hover:text-gray-100 transition-colors"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="18" x2="20" y2="18" />
        </svg>
        <span className="text-sm font-semibold">PraBob</span>
      </button>

      {mounted && open && createPortal(
        <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-[300px] max-w-[85vw] overflow-y-auto bg-gray-950 shadow-2xl border-r border-gray-800">
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              className="absolute right-2 top-2 z-10 rounded p-1 text-gray-300 bg-gray-900/60 hover:text-white"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
            <div className="p-4 pt-12">
              <ResourcesPanel />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
