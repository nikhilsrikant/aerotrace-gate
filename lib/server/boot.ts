// Entry point for the web role: `node dist/boot.mjs /app/server.js`. Prepares the process, then starts Next.js.
import { prepareProcess } from './prepare';

const target = process.argv[2];
if (!target) { process.stderr.write('usage: boot.mjs <server.js>\n'); process.exit(2); }
prepareProcess('web', ['DATABASE_URL', 'SESSION_SECRET'])
  .then(() => import(target))
  .catch(e => { process.stderr.write(`aerotrace: ${(e as Error).message}\n`); process.exit(1); });
