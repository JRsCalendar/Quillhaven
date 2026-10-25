// Real MCP client for hosts whose tool catalog has not reloaded yet.
// Usage: node scripts/mcp-client.mjs; stdin accepts {name,arguments} per line.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const client = new Client({ name: 'quillhaven-local-client', version: '0.2.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../mcp-server.mjs', import.meta.url))], env: { ...process.env }, stderr: 'inherit' });
let input;
try {
  await client.connect(transport);
  console.error('MCP connected. Send {"name":"workspace_overview","arguments":{}}; /tools lists schemas; /quit disconnects.');
  input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    if (line === '/quit') break;
    try { console.log(JSON.stringify(line === '/tools' ? await client.listTools() : await client.callTool(JSON.parse(line)))); }
    catch (error) { console.log(JSON.stringify({ isError: true, error: error.message })); }
  }
} finally {
  input?.close();
  await client.close();
  process.stdin.pause();
  process.stdin.unref?.();
}
