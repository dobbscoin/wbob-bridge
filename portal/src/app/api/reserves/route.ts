import { NextResponse } from 'next/server';
import { getReserves } from '@/lib/reserves';

// Read the chains at request time (behind the 60 s in-memory cache), never at build time.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const report = await getReserves();
  return NextResponse.json(report, {
    headers: { 'Cache-Control': 'public, max-age=30' },
  });
}
