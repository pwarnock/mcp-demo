import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { startFakeVault } from './fake-vault.js';
import { createHttpSink } from './secret-sink.js';
import { StateStore } from './store.js';
import { TokenCollector } from './token-flow.js';

const MAX_ACTIVE_TASKS = 8;
const TOKEN_PAGE_WAIT_MS = 120_000;

// stdout carries protocol messages only; every diagnostic goes to stderr.
const config = loadConfig(process.env);
if (config.keyGenerated) {
  console.error('[release-manager] REQUEST_STATE_KEY is not set: using a random key, so rollback confirmations will not survive a restart.');
}
const store = new StateStore({ path: config.statePath, maxActiveTasks: MAX_ACTIVE_TASKS });
let sinkUrl = config.secretSinkUrl;
let sinkAuth = config.secretSinkAuth;
if (sinkUrl === undefined) {
  const vault = await startFakeVault({ log: true });
  sinkUrl = `${vault.url}/secrets`;
  sinkAuth = vault.authToken;
  console.error('[release-manager] SECRET_SINK_URL is not set: set_registry_token sends the token to a built-in fake vault in this process (demo only).');
}
const tokens = new TokenCollector({ sink: createHttpSink({ url: sinkUrl, authToken: sinkAuth }) });

serveStdio(() => createServer({ store, stepDelayMs: config.stepDelayMs, requestStateKey: config.requestStateKey, tokens, urlWaitMs: TOKEN_PAGE_WAIT_MS }), {
  legacy: 'reject',
  onerror: (error) => console.error('[release-manager] transport error:', error.message),
});
