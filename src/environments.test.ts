import { describe, expect, it } from 'vitest';
import { SEED_ENVIRONMENTS, SERVICE_PATTERN, VERSION_PATTERN } from './environments.js';

describe('SERVICE_PATTERN', () => {
  it('accepts web and api', () => {
    expect(SERVICE_PATTERN.test('web')).toBe(true);
    expect(SERVICE_PATTERN.test('api')).toBe(true);
  });

  it.each(['../etc', 'Web', 'a', 'web service', 'a'.repeat(33), 'web\n'])('rejects %j', (value) => {
    expect(SERVICE_PATTERN.test(value)).toBe(false);
  });
});

describe('VERSION_PATTERN', () => {
  it('accepts 1.4.0', () => {
    expect(VERSION_PATTERN.test('1.4.0')).toBe(true);
  });

  it.each(['1.4', 'v1.4.0', '1.4.0-rc1', '1.4.0\n'])('rejects %j', (value) => {
    expect(VERSION_PATTERN.test(value)).toBe(false);
  });
});

describe('SEED_ENVIRONMENTS', () => {
  it('runs web and api at the documented versions', () => {
    expect(SEED_ENVIRONMENTS).toEqual({
      dev: { web: '1.4.0', api: '1.4.0' },
      staging: { web: '1.3.2', api: '1.3.2' },
      production: { web: '1.3.0', api: '1.3.0' },
    });
  });
});
