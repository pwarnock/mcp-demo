import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface Config {
  statePath: string;
  /** Pause between the simulated deploy steps. A test knob; leave at the default for a demo. */
  stepDelayMs: number;
  requestStateKey: Uint8Array;
  /** True when no REQUEST_STATE_KEY was set and a random one was made for this process. */
  keyGenerated: boolean;
}

const MAX_STEP_DELAY_MS = 600_000;
/** Next to the repo, not the caller's working directory: Claude Code starts servers wherever the user ran it. */
const DEFAULT_STATE_PATH = fileURLToPath(new URL('../.state/state.json', import.meta.url));

export function loadConfig(env: Record<string, string | undefined>): Config {
  const rawDelay = env.STEP_DELAY_MS ?? '1500';
  if (!/^\d+$/.test(rawDelay) || Number(rawDelay) > MAX_STEP_DELAY_MS) {
    throw new Error(`STEP_DELAY_MS must be a whole number of milliseconds from 0 to ${MAX_STEP_DELAY_MS}`);
  }
  const rawKey = env.REQUEST_STATE_KEY;
  if (rawKey !== undefined && !/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    throw new Error('REQUEST_STATE_KEY must be 64 hex characters (32 bytes)');
  }
  return {
    statePath: env.STATE_PATH ?? DEFAULT_STATE_PATH,
    stepDelayMs: Number(rawDelay),
    requestStateKey: rawKey === undefined ? randomBytes(32) : Uint8Array.from(Buffer.from(rawKey, 'hex')),
    keyGenerated: rawKey === undefined,
  };
}
