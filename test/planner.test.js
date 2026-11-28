import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planBootstrap,
  walRetentionWindow,
  remapAcrossSwitchovers,
} from '../src/planner.js';

// 构造一段连续 WAL 段：从 from 到 to，每段 size 字节。
function walSegments(from, to, size = 0x1000000) {
  const segments = [];
  for (let start = BigInt(from); start < BigInt(to); start += BigInt(size)) {
    const end = start + BigInt(size);
    segments.push({
      name: `seg-${segments.length}`,
      startLsn: `0/${start.toString(16).toUpperCase()}`,
      endLsn: `0/${end.toString(16).toUpperCase()}`,
    });
  }
  return segments;
}

const baseInput = () => ({
  slot: { name: 'sub_slot', restartLsn: '0/1000000', confirmedLsn: '0/1000000' },
  snapshot: {
    boundaryLsn: '0/5000000',
    tables: [
      {
        name: 'orders',
        status: 'done',
        captureStartLsn: '0/1000000',
        captureEndLsn: '0/3000000',
      },
    ],
  },
  walSegments: walSegments(0x1000000n, 0x6000000n),
  lag: { bytes: 1024, maxAllowedBytes: 1_000_000 },
  switchoverEvents: [],
});

test('槽提前创建：快照覆盖区间被识别为重复范围', () => {
  const plan = planBootstrap(baseInput());
  assert.equal(plan.ok, true);
  const orders = plan.tables[0];
  assert.equal(orders.status, 'ready');
  assert.equal(orders.recoveryLsn, '0/3000000');
  assert.deepEqual(orders.duplicateRange, {
    startLsn: '0/1000000',
    endLsn: '0/3000000',
    bytes: 0x2000000,
  });
  assert.equal(plan.globalStartLsn, '0/3000000');
});

test('表级并行快照不同步：各表恢复点不同，全局起点取最小值', () => {
  const input = baseInput();
  input.snapshot.tables = [
    { name: 'orders', status: 'done', captureStartLsn: '0/1000000', captureEndLsn: '0/2000000' },
    { name: 'users', status: 'done', captureStartLsn: '0/1000000', captureEndLsn: '0/4500000' },
    { name: 'logs', status: 'done', captureStartLsn: '0/1000000', captureEndLsn: '0/3800000' },
  ];
  const plan = planBootstrap(input);
  assert.equal(plan.ok, true);
  assert.equal(plan.globalStartLsn, '0/2000000');
  const byName = Object.fromEntries(plan.tables.map((t) => [t.name, t]));
  assert.equal(byName.orders.recoveryLsn, '0/2000000');
  assert.equal(byName.users.recoveryLsn, '0/4500000');
  assert.equal(byName.logs.recoveryLsn, '0/3800000');
  // users 表快照覆盖更久，重复范围更大
  assert.equal(byName.users.duplicateRange.bytes, 0x3500000);
  assert.equal(byName.orders.duplicateRange.bytes, 0x1000000);
});

test('WAL 保留不足：恢复点被截断的表标记为 wal_truncated', () => {
  const input = baseInput();
  // WAL 只保留到 0/3500000 之后，而 orders 的恢复点是 0/3000000
  input.walSegments = walSegments(0x3500000n, 0x6000000n);
  const plan = planBootstrap(input);
  const orders = plan.tables[0];
  assert.equal(orders.status, 'wal_truncated');
  assert.equal(orders.walAvailable, false);
  assert.match(orders.reason, /重新快照/);
  assert.equal(plan.ok, false);
  const cond = plan.switchover.conditions.find((c) => c.id === 'all_tables_ready');
  assert.equal(cond.ok, false);
});

test('快照失败：槽起点仍保留则可全量追赶，否则必须重建槽', () => {
  const input = baseInput();
  input.snapshot.tables = [
    { name: 'orders', status: 'failed', captureStartLsn: '0/1000000', captureEndLsn: '0/3000000' },
  ];
  let plan = planBootstrap(input);
  assert.equal(plan.tables[0].status, 'needs_full_replay');
  assert.equal(plan.tables[0].recoveryLsn, '0/1000000');
  assert.equal(plan.tables[0].duplicateRange, null);
  assert.equal(plan.ok, false);

  // 槽起点之前的 WAL 也被截断 → 不可恢复
  input.walSegments = walSegments(0x2000000n, 0x6000000n);
  plan = planBootstrap(input);
  assert.equal(plan.tables[0].status, 'wal_truncated');
  assert.match(plan.tables[0].reason, /重建复制槽/);
});

test('中途重启：进行中的表不算已捕获，重跑规划结果幂等', () => {
  const input = baseInput();
  input.snapshot.tables = [
    { name: 'orders', status: 'done', captureStartLsn: '0/1000000', captureEndLsn: '0/3000000' },
    { name: 'users', status: 'in_progress', captureStartLsn: '0/1000000', captureEndLsn: '0/4000000' },
  ];
  const first = planBootstrap(input);
  assert.equal(first.tables[1].status, 'needs_full_replay');
  // 模拟重启后用持久化状态重新规划：纯函数，结果完全一致
  const second = planBootstrap(input);
  assert.deepEqual(second, first);
  // 重启后 users 快照完成，恢复点更新
  input.snapshot.tables[1] = {
    name: 'users',
    status: 'done',
    captureStartLsn: '0/1000000',
    captureEndLsn: '0/4000000',
  };
  const resumed = planBootstrap(input);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.tables[1].recoveryLsn, '0/4000000');
  assert.equal(resumed.globalStartLsn, '0/3000000');
});

test('切换事件：恢复点映射到新时间线，未映射事件导致切换不安全', () => {
  const input = baseInput();
  input.switchoverEvents = [
    { label: 'failover-1', atLsn: '0/2000000', newStartLsn: '0/8000000' },
  ];
  input.walSegments = walSegments(0x8000000n, 0x9000000n);
  const plan = planBootstrap(input);
  // 恢复点 0/3000000 在切换点之后 → 映射为 0/8000000 + 0/1000000
  assert.equal(plan.tables[0].recoveryLsn, '0/9000000');
  assert.equal(plan.ok, true);

  // 事件缺少 newStartLsn → 无法安全跨越
  input.switchoverEvents = [{ label: 'failover-2', atLsn: '0/2000000' }];
  input.walSegments = walSegments(0x1000000n, 0x6000000n);
  const unsafe = planBootstrap(input);
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.switchover.safe, false);
  assert.equal(unsafe.switchover.unmappedEvents.length, 1);
  const cond = unsafe.switchover.conditions.find((c) => c.id === 'switchovers_mapped');
  assert.equal(cond.ok, false);
});

test('复制延迟超阈值时切换不安全并产生告警', () => {
  const input = baseInput();
  input.lag = { bytes: 5_000_000, maxAllowedBytes: 1_000_000 };
  const plan = planBootstrap(input);
  assert.equal(plan.ok, false);
  assert.equal(plan.lag.withinBudget, false);
  assert.ok(plan.warnings.some((w) => w.includes('延迟')));
});

test('walRetentionWindow 计算保留窗口', () => {
  const window = walRetentionWindow(walSegments(0x2000000n, 0x5000000n));
  assert.equal(window.retainedFromLsn, 0x2000000n);
  assert.equal(window.retainedToLsn, 0x5000000n);
  assert.deepEqual(walRetentionWindow([]), {
    retainedFromLsn: null,
    retainedToLsn: null,
  });
});

test('remapAcrossSwitchovers 按事件顺序级联映射', () => {
  const events = [
    { atLsn: '0/2000000', newStartLsn: '0/8000000' },
    { atLsn: '0/9000000', newStartLsn: '0/F000000' },
  ];
  // 0/A000000 → 第一次映射后 0/... 已超过第二个事件 atLsn，继续级联
  const { lsn } = remapAcrossSwitchovers('0/A000000', events);
  // 0/A000000 → 0x8000000+(0x8000000)=0x10000000 → 0xF000000+(0x7000000)=0x16000000
  assert.equal(lsn, 0x16000000n);
  const before = remapAcrossSwitchovers('0/1000000', events);
  assert.equal(before.lsn, 0x1000000n);
});
