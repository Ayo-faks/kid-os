import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_ROUTE = Symbol('IS_PUBLIC_ROUTE');

export const Public = (): ReturnType<typeof SetMetadata> => SetMetadata(IS_PUBLIC_ROUTE, true);
