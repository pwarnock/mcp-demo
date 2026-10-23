import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
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
const tokens = new TokenCollector();

serveStdio(() => createServer({ store, stepDelayMs: config.stepDelayMs, requestStateKey: config.requestStateKey, tokens, urlWaitMs: TOKEN_PAGE_WAIT_MS }), {
  legacy: 'reject',
  onerror: (error) => console.error('[release-manager] transport error:', error.message),
});
