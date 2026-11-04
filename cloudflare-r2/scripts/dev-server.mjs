import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const folder = dirname(fileURLToPath(import.meta.url));
const project = resolve(folder, '..');
const config = JSON.parse(readFileSync(resolve(project, 'wrangler.jsonc'), 'utf8'));
const durableObjects = Object.fromEntries(config.durable_objects.bindings.map(binding => [
  binding.name, { className: binding.class_name, useSQLite: true }
]));

const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port: 8787,
  workers: [{
    modules: true,
    scriptPath: resolve(project, config.main),
    compatibilityDate: config.compatibility_date,
    r2Buckets: config.r2_buckets.map(binding => binding.binding),
    durableObjects,
    bindings: {
      ...config.vars,
      ALBUM_ADMIN_TOKEN: 'local-only-admin-token'
    }
  }]
}));

await runtime.ready;
console.log('Marcela local Worker ready at http://127.0.0.1:8787 (emulated R2 and SQLite; no remote writes).');
console.log('Local admin-only routes use a development token and are unavailable in the deployed frontend.');

async function stop() {
  await runtime.dispose();
  process.exit(0);
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
