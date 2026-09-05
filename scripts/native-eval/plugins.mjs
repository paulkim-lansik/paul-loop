import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { bounded } from './process.mjs';
import { save } from './adapter.mjs';
export function codexPlugins(executable, root, output) {
  root = resolve(root);
  const catalog = JSON.parse(readFileSync(join(root, '.agents/plugins/marketplace.json')));
  if (!/^[a-zA-Z0-9._-]+$/.test(catalog.name)) throw Error('invalid marketplace identity');
  const ids = ['loop-engine', 'ship-flow'].map(name => `${name}@${catalog.name}`);
  for (const name of ['loop-engine', 'ship-flow']) if (!catalog.plugins.some(p => p.name === name)) throw Error('marketplace missing required plugin');
  return async ({ env }) => {
    const records = [];
    for (const args of [['plugin','marketplace','add',root,'--json'], ...ids.map(id => ['plugin','add',id,'--json'])]) {
      const r = await bounded(executable, args, { env, timeoutMs: 15000 }); records.push({ command: [executable,...args], ...r });
      save(join(output, 'plugin-setup.json'), records);
      if (r.exit !== 0 || r.fault) throw Error(`native registration incomplete: ${r.stderr}`);
    }
    return { pluginIds: ids, versions: records.slice(1).map(r => { const p=JSON.parse(r.stdout); return { name:p.name,version:p.version }; }), trust: 'unchanged; not attested' };
  };
}
