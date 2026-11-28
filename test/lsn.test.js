import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLsn, formatLsn, compareLsn, lsnDistance } from '../src/lsn.js';

test('解析与格式化 LSN 往返一致', () => {
  assert.equal(formatLsn(parseLsn('0/16B6C50')), '0/16B6C50');
  assert.equal(formatLsn(parseLsn('1/0')), '1/0');
  assert.equal(formatLsn(parseLsn('2/FFFFFFFF')), '2/FFFFFFFF');
});

test('跨 32 位边界比较与距离', () => {
  assert.equal(compareLsn('0/FFFFFFFF', '1/0'), -1);
  assert.equal(compareLsn('1/0', '1/0'), 0);
  assert.equal(lsnDistance('0/FFFFFFFF', '1/1'), 2n);
});

test('非法 LSN 抛错', () => {
  assert.throws(() => parseLsn('not-an-lsn'));
  assert.throws(() => parseLsn('0x10'));
});
