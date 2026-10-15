import { loadServerEnv } from '@1pos/config';

export const ENV = Symbol('ENV');

export const envProvider = {
  provide: ENV,
  useFactory: () => loadServerEnv(),
};
