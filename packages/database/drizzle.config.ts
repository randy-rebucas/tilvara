import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_MIGRATOR_URL ?? 'postgres://onepos_migrator:onepos_migrator_dev@127.0.0.1:55460/onepos',
  },
  strict: true,
});
