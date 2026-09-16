import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { agentTimestamp, agentConnection } from '../src/agentHealth.ts';

test('API Korean local timestamps are independent of browser timezone', () => {
  assert.equal(agentTimestamp('2026-09-16T09:11:00'), Date.parse('2026-09-16T00:11:00Z'));
  assert.equal(agentTimestamp('2026-09-16T09:11:00+09:00'), agentTimestamp('2026-09-16T00:11:00Z'));
  assert.equal(agentTimestamp(''), null);
  assert.equal(agentTimestamp('bad-date'), null);
});
test('connection expires even when the API fails to refresh', () => {
  const last = Date.parse('2026-09-16T00:11:00Z');
  assert.equal(agentConnection(last, last + 180_000), 'online');
  assert.equal(agentConnection(last, last + 180_001), 'offline');
  assert.equal(agentConnection(null, last), 'unknown');
  assert.equal(agentConnection(last + 120_000, last), 'unknown');
});
