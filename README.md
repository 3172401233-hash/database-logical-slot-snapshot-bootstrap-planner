# database-logical-slot-snapshot-bootstrap-planner
规划逻辑槽快照初始化、追赶和切换

> **注意：本项目中所有复制状态（复制槽、快照进度、WAL 段、复制延迟、
> 切换事件）均为模拟输入。代码不连接任何真实数据库，规划器是纯函数，
> 仅用于推演 bootstrap 策略。**

## 背景

逻辑复制槽在基础快照**之前**创建，追赶期间主库继续产生 WAL。快照完成时，
某些表的数据已经覆盖槽起点之后的位点；若订阅直接从槽起点消费，这些表会
重复应用变更。本工具根据模拟的槽 LSN、快照边界、各表捕获位置、WAL 段、
复制延迟和切换事件，计算快照后每张表应从哪个 LSN 开始消费。

## 输入

```js
planBootstrap({
  slot: { name, restartLsn, confirmedLsn },   // 快照前已创建的复制槽
  snapshot: {
    boundaryLsn,                              // 快照整体边界
    tables: [{ name, status, captureStartLsn, captureEndLsn }],
    // status: done | failed | in_progress | pending（支持表级并行快照）
  },
  walSegments: [{ name, startLsn, endLsn }],  // 模拟 WAL 保留情况
  lag: { bytes, maxAllowedBytes },            // 复制延迟与阈值
  switchoverEvents: [{ atLsn, newStartLsn }], // 切换事件（时间线映射）
});
```

## 输出

- `globalStartLsn`：单订阅的全局消费起点（各就绪表恢复点的最小值）。
- `tables[].recoveryLsn`：每表恢复点；`duplicateRange` 为快照已覆盖、
  需跳过的重复区间；`status` 为 `ready` / `needs_full_replay` /
  `wal_truncated`。
- `switchover.conditions`：安全切换条件——全部表就绪、恢复点落在 WAL
  保留窗口内、切换事件均有新时间线映射、延迟在阈值内。

## 处理的场景

- **表级并行快照**：各表捕获位置不同步，分别给出恢复点与重复范围。
- **槽提前创建**：槽起点到捕获结束位点之间的 WAL 被识别为重复区间。
- **WAL 保留不足**：恢复点早于保留起点时标记 `wal_truncated`，需重新
  快照或重建复制槽。
- **中途重启**：规划器是纯函数，用持久化的快照进度重新调用即得一致
  结果（幂等）；`in_progress` 的表不视为已捕获。

## 运行测试

```sh
node --test   # 需要 Node.js 24.16.0
```
