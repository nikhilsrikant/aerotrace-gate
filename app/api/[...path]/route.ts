import type { NextRequest } from 'next/server';
import { dispatch } from '@/lib/server/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type P = { params: Promise<{ path: string[] }> };
const go = async (req: NextRequest, { params }: P) => dispatch(req, (await params).path);
export { go as GET, go as POST, go as PUT, go as PATCH, go as DELETE };
