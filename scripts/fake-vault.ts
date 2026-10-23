// Runs the demo fake vault as its own process, so you can watch the token arrive in this terminal.
//   bun run vault
// then register the server with SECRET_SINK_URL=http://127.0.0.1:8787/secrets and SECRET_SINK_AUTH=demo-vault-token.
import { startFakeVault } from '../src/fake-vault.js';

const authToken = process.env.SECRET_SINK_AUTH ?? 'demo-vault-token';
const vault = await startFakeVault({ port: Number(process.env.VAULT_PORT ?? 8787), authToken, log: true });
console.error(`[fake-vault] listening on ${vault.url} (demo only; keeps secrets in memory and never returns them)`);
setInterval(() => {}, 1 << 30); // keep this process alive; the vault's own server is unref'd
