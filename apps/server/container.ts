import { createContainer, type AwilixContainer } from 'awilix';
import IContextContainer from './context/icontext-container';
import services from './services';
import models from './models';
import type { User as PrismaUser } from '@prisma/client';

declare global {
  namespace Express {
    interface User extends PrismaUser {}
    interface Request {
      user?: PrismaUser;
      /**
       * The per-request scope installed by `scopePerRequest`. awilix-express
       * types its own middleware with `req: any`, so without this every
       * middleware reaching for the container casts through `any` and no longer
       * sees what the cradle actually holds.
       */
      container?: AwilixContainer<IContextContainer>;
    }
  }
}

const container = createContainer<IContextContainer>();

container.register({
  ...services,
  ...models,
});

export default container;
