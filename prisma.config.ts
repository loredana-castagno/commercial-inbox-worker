import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { resolveDatabaseFile } from './src/database-url.js';

// Prisma 7 no carga .env por su cuenta: lo hace el import de arriba.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: `file:${resolveDatabaseFile()}` },
});
