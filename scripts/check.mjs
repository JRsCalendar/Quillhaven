import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const files = ['server.mjs','mcp-server.mjs'];
for (const folder of ['dist','lib','scripts','tests']) for (const file of readdirSync(new URL(`../${folder}/`, import.meta.url))) if (/\.(m?js)$/.test(file)) files.push(`${folder}/${file}`);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check',fileURLToPath(new URL(`../${file}`, import.meta.url))], { stdio:'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`${files.length} 个 JavaScript 文件语法检查通过。`);
