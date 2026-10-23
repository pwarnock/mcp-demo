import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const hex = 'ab'.repeat(32);

describe('loadConfig', () => {
  it('uses documented defaults and generates a key when none is set', () => {
    const cfg = loadConfig({});
    expect(cfg).toMatchObject({ statePath: '.state/state.json', stepDelayMs: 1500, keyGenerated: true });
    expect(cfg.requestStateKey).toHaveLength(32);
  });

  it('two generated keys differ', () => {
    expect(Buffer.from(loadConfig({}).requestStateKey).equals(Buffer.from(loadConfig({}).requestStateKey))).toBe(false);
  });

  it('reads STATE_PATH, STEP_DELAY_MS and a 64-character hex REQUEST_STATE_KEY', () => {
    const cfg = loadConfig({ STATE_PATH: '/tmp/x.json', STEP_DELAY_MS: '0', REQUEST_STATE_KEY: hex });
    expect(cfg).toMatchObject({ statePath: '/tmp/x.json', stepDelayMs: 0, keyGenerated: false });
    expect(Buffer.from(cfg.requestStateKey).toString('hex')).toBe(hex);
  });

  it.each(['', 'zz'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33)])('rejects the REQUEST_STATE_KEY %j without echoing it', (bad) => {
    let message = '';
    try {
      loadConfig({ REQUEST_STATE_KEY: bad });
    } catch (e) {
      message = String(e);
    }
    expect(message).toMatch(/REQUEST_STATE_KEY/);
    if (bad.length > 0) expect(message).not.toContain(bad);
  });

  it.each(['-1', 'abc', '1.5', '600001'])('rejects STEP_DELAY_MS %j', (bad) => {
    expect(() => loadConfig({ STEP_DELAY_MS: bad })).toThrow(/STEP_DELAY_MS/);
  });
});
