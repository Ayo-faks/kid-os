import NextAuth from 'next-auth';

import { authOptions } from '@/lib/auth';

type RouteHandler = (request: Request) => Promise<Response>;

const handler = NextAuth(authOptions) as unknown as RouteHandler;

export { handler as GET, handler as POST };
