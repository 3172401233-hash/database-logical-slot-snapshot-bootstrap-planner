// 逻辑复制槽快照 bootstrap 规划器。
//
// 场景：逻辑复制槽在基础快照之前创建，追赶期间主库继续产生 WAL。
// 快照完成时，部分表的数据已经覆盖槽起点之后的位点，若订阅直接从槽
// 起点消费会重复应用。规划器根据槽 LSN、快照边界、各表捕获位置、
// WAL 段保留情况、复制延迟与切换事件，计算每张表应从哪个 LSN 开始
// 消费，并给出重复范围与安全切换条件。
//
// 注意：所有复制状态（槽、快照、WAL、延迟、切换）均为模拟输入，
// 本模块是纯函数，不访问任何真实数据库。

import { parseLsn, formatLsn, compareLsn, lsnDistance } from './lsn.js';

const TABLE_STATUS = new Set(['done', 'failed', 'in_progress', 'pending']);

/**
 * 计算 WAL 保留窗口。
 * @param {Array<{name:string,startLsn:string,endLsn:string}>} segments 模拟 WAL 段
 */
export function walRetentionWindow(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { retainedFromLsn: null, retainedToLsn: null };
  }
  let from = null;
  let to = null;
  for (const seg of segments) {
    const start = parseLsn(seg.startLsn);
    const end = parseLsn(seg.endLsn);
    if (from === null || start < from) from = start;
    if (to === null || end > to) to = end;
  }
  return { retainedFromLsn: from, retainedToLsn: to };
}

/**
 * 沿切换（switchover/failover）事件把旧时间线 LSN 映射到新时间线。
 * 事件形如 { atLsn, newStartLsn, label }：旧时间线在 atLsn 处切换，
 * 新时间线从 newStartLsn 继续，偏移量保持不变。
 * 缺少 newStartLsn 的事件视为未映射，消费无法安全跨越。
 */
export function remapAcrossSwitchovers(lsn, events) {
  let current = parseLsn(lsn);
  const sorted = [...(events ?? [])].sort((a, b) =>
    compareLsn(a.atLsn, b.atLsn),
  );
  const unmapped = [];
  for (const event of sorted) {
    const at = parseLsn(event.atLsn);
    if (current >= at) {
      if (event.newStartLsn == null) {
        unmapped.push(event);
      } else {
        current = parseLsn(event.newStartLsn) + (current - at);
      }
    }
  }
  return { lsn: current, unmapped };
}

function planTable(table, slotRestartLsn, retention, events) {
  const name = table.name;
  if (!TABLE_STATUS.has(table.status)) {
    throw new Error(`表 ${name} 的快照状态非法: ${table.status}`);
  }

  const base = {
    name,
    snapshotStatus: table.status,
    recoveryLsn: null,
    duplicateRange: null,
    walAvailable: false,
    status: 'pending',
    reason: '',
  };

  if (table.status !== 'done') {
    // 快照未完成（失败/进行中/未开始）：没有可用的快照数据，
    // 只能从槽起点全量消费，或重新快照。
    const remap = remapAcrossSwitchovers(slotRestartLsn, events);
    const truncated =
      retention.retainedFromLsn !== null &&
      remap.lsn < retention.retainedFromLsn;
    return {
      ...base,
      recoveryLsn: formatLsn(remap.lsn),
      walAvailable: !truncated,
      status: truncated ? 'wal_truncated' : 'needs_full_replay',
      reason: truncated
        ? `快照${table.status === 'failed' ? '失败' : '未完成'}，且槽起点 ${formatLsn(remap.lsn)} 之前的 WAL 已被截断，必须重建复制槽并重新快照`
        : `快照${table.status === 'failed' ? '失败' : '未完成'}，需从槽起点全量追赶或重新快照`,
      unmappedSwitchovers: remap.unmapped,
    };
  }

  // 快照完成：快照数据已覆盖 [captureStartLsn, captureEndLsn) 的变更，
  // 该区间即重复范围，消费应从 captureEndLsn 开始。
  const captureEnd = parseLsn(table.captureEndLsn);
  const captureStart = parseLsn(table.captureStartLsn);
  if (captureEnd < captureStart) {
    throw new Error(`表 ${name} 的捕获区间非法: end < start`);
  }

  const recovery = captureEnd > slotRestartLsn ? captureEnd : slotRestartLsn;
  const remap = remapAcrossSwitchovers(recovery, events);
  const truncated =
    retention.retainedFromLsn !== null &&
    remap.lsn < retention.retainedFromLsn;

  const duplicateEnd = captureEnd > slotRestartLsn ? captureEnd : slotRestartLsn;
  const duplicateRange =
    duplicateEnd > slotRestartLsn
      ? {
          startLsn: formatLsn(slotRestartLsn),
          endLsn: formatLsn(duplicateEnd),
          bytes: Number(duplicateEnd - slotRestartLsn),
        }
      : null;

  return {
    ...base,
    recoveryLsn: formatLsn(remap.lsn),
    duplicateRange,
    walAvailable: !truncated,
    status: truncated ? 'wal_truncated' : 'ready',
    reason: truncated
      ? `恢复点 ${formatLsn(remap.lsn)} 之前的 WAL 已被截断（保留自 ${formatLsn(retention.retainedFromLsn)}），必须重新快照`
      : '快照有效，从捕获结束位点继续消费',
    unmappedSwitchovers: remap.unmapped,
  };
}

/**
 * 生成 bootstrap 计划。纯函数：相同输入产生相同输出，因此中途重启后
 * 用持久化的快照进度重新调用即可得到一致的恢复点（幂等）。
 *
 * @param {object} input
 * @param {{name:string, restartLsn:string, confirmedLsn?:string}} input.slot 复制槽（快照前已创建）
 * @param {{boundaryLsn:string, tables:Array}} input.snapshot 快照边界与各表捕获位置
 * @param {Array} input.walSegments 模拟 WAL 段
 * @param {{bytes?:number, maxAllowedBytes?:number}} [input.lag] 复制延迟
 * @param {Array} [input.switchoverEvents] 切换事件
 */
export function planBootstrap(input) {
  const { slot, snapshot } = input;
  if (!slot?.restartLsn) throw new Error('缺少 slot.restartLsn');
  if (!snapshot?.boundaryLsn) throw new Error('缺少 snapshot.boundaryLsn');

  const slotRestartLsn = parseLsn(slot.restartLsn);
  const events = input.switchoverEvents ?? [];
  const retention = walRetentionWindow(input.walSegments);
  const warnings = [];

  const tables = (snapshot.tables ?? []).map((table) =>
    planTable(table, slotRestartLsn, retention, events),
  );

  const readyTables = tables.filter((t) => t.status === 'ready');
  const blockedTables = tables.filter((t) => t.status !== 'ready');

  // 全局起点：所有就绪表恢复点的最小值；单订阅从该位点开始消费，
  // 各表按自己的恢复点跳过重复区间（表级并行快照的错位由重复范围描述）。
  let globalStartLsn = null;
  if (readyTables.length > 0) {
    globalStartLsn = readyTables
      .map((t) => parseLsn(t.recoveryLsn))
      .reduce((a, b) => (a < b ? a : b));
  }

  // 切换安全性：从全局起点到 WAL 末尾之间不允许存在未映射的切换事件。
  const unmappedEvents = [];
  if (globalStartLsn !== null && retention.retainedToLsn !== null) {
    for (const event of events) {
      if (event.newStartLsn == null) {
        unmappedEvents.push(event);
      }
    }
  }

  const lagBytes = input.lag?.bytes ?? 0;
  const maxLag = input.lag?.maxAllowedBytes ?? Infinity;
  const lagOk = lagBytes <= maxLag;
  if (!lagOk) {
    warnings.push(`复制延迟 ${lagBytes} 字节超过阈值 ${maxLag} 字节`);
  }
  if (retention.retainedFromLsn === null) {
    warnings.push('没有可用的 WAL 段，无法从任何位点消费');
  }

  const conditions = [
    {
      id: 'all_tables_ready',
      ok: blockedTables.length === 0,
      detail:
        blockedTables.length === 0
          ? '所有表快照有效且恢复点落在 WAL 保留窗口内'
          : `${blockedTables.length} 张表未就绪: ${blockedTables.map((t) => `${t.name}(${t.status})`).join(', ')}`,
    },
    {
      id: 'wal_retained',
      ok:
        globalStartLsn !== null &&
        retention.retainedFromLsn !== null &&
        globalStartLsn >= retention.retainedFromLsn,
      detail:
        globalStartLsn !== null && retention.retainedFromLsn !== null
          ? `全局起点 ${formatLsn(globalStartLsn)}，WAL 保留自 ${formatLsn(retention.retainedFromLsn)}`
          : '无法确定全局起点或 WAL 保留窗口',
    },
    {
      id: 'switchovers_mapped',
      ok: unmappedEvents.length === 0,
      detail:
        unmappedEvents.length === 0
          ? '所有切换事件均有新时间线映射'
          : `${unmappedEvents.length} 个切换事件缺少映射，消费无法安全跨越`,
    },
    {
      id: 'lag_within_budget',
      ok: lagOk,
      detail: `当前延迟 ${lagBytes} 字节，阈值 ${maxLag === Infinity ? '无限制' : `${maxLag} 字节`}`,
    },
  ];

  return {
    ok: conditions.every((c) => c.ok),
    slot: {
      name: slot.name ?? 'slot',
      restartLsn: formatLsn(slotRestartLsn),
      confirmedLsn: slot.confirmedLsn ? formatLsn(slot.confirmedLsn) : null,
    },
    snapshotBoundaryLsn: formatLsn(snapshot.boundaryLsn),
    globalStartLsn: globalStartLsn === null ? null : formatLsn(globalStartLsn),
    wal: {
      retainedFromLsn:
        retention.retainedFromLsn === null
          ? null
          : formatLsn(retention.retainedFromLsn),
      retainedToLsn:
        retention.retainedToLsn === null
          ? null
          : formatLsn(retention.retainedToLsn),
      segmentCount: (input.walSegments ?? []).length,
    },
    tables,
    switchover: {
      safe: conditions.every((c) => c.ok),
      conditions,
      unmappedEvents,
    },
    lag: { bytes: lagBytes, maxAllowedBytes: maxLag, withinBudget: lagOk },
    warnings,
  };
}
