import test from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, recentDays, dateLabel } from '../dist/chat-store.js';

test('Hong Kong midnight moves the recent window without including the day before yesterday', () => {
  assert.equal(dayKey(new Date('2026-10-24T15:59:59Z')), '2026-10-24');
  assert.deepEqual(recentDays(new Date('2026-10-24T16:00:00Z')), { today: '2026-10-25', yesterday: '2026-10-24' });
  assert.equal(dateLabel('2026-10-23', new Date('2026-10-24T16:00:00Z')), '2026.10.23');
});
test('daily grouping handles year and leap-month boundaries', () => {
  assert.deepEqual(recentDays(new Date('2026-12-31T16:00:00Z')), { today: '2027-01-01', yesterday: '2026-12-31' });
  assert.deepEqual(recentDays(new Date('2028-02-29T16:00:00Z')), { today: '2028-03-01', yesterday: '2028-02-29' });
});
