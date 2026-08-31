import { getConfig } from '../config.js';
import { closeDb, getDb } from '../db.js';

const config = getConfig();
const db = await getDb();
const count = await db.emailTriage.count();

console.log('Config OK');
console.log(`  NODE_ENV             ${config.NODE_ENV}`);
console.log(`  GMAIL_WRITE          ${config.GMAIL_WRITE_ENABLED}`);
console.log(`  EXTERNAL_WRITE       ${config.EXTERNAL_WRITE_ENABLED}`);
console.log(`  AUTO_CATEGORIES      ${config.AUTO_CATEGORIES.join(',') || '(ninguna)'}`);
console.log(`  GMAIL_USER_EMAIL     ${config.GMAIL_USER_EMAIL}`);
console.log(`  GMAIL_SCOPE          ${config.GMAIL_SCOPE}`);
console.log(`  ANTHROPIC_MODEL      ${config.ANTHROPIC_MODEL}`);
console.log(`  CONFIDENCE_THRESHOLD ${config.CONFIDENCE_THRESHOLD}`);
console.log(`DB OK (WAL activo) — EmailTriage: ${count} filas`);

await closeDb();
