// Usage: npm run seed            -> add sample data if none exists
//        npm run seed -- --reset -> remove old sample data first, then add fresh sample data
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getSettings, setFlag } from './db.js';
import { seedSample, clearSample } from './seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const db = openDb(process.env.DB_FILE || path.resolve(here, '../data/daypilot.db'));
if (process.argv.includes('--reset')) console.log('Removed sample data:', clearSample(db));
const result = seedSample(db, getSettings(db), new Date());
setFlag(db, 'seeded', '1');
console.log(result.skipped ? 'Sample data already present (use --reset to refresh it).' : `Added sample data: ${result.tasks} tasks, ${result.meetings} meetings.`);
db.close();
