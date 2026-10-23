import { McpServer } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';

it('imports the SDK', () => {
  expect(typeof McpServer).toBe('function');
});
