// LSN 工具：解析、格式化、比较 PostgreSQL 风格的 "X/Y" 日志序列号。
// 本项目中所有 LSN 均为模拟数据，不连接真实数据库。

const LSN_RE = /^([0-9A-Fa-f]+)\/([0-9A-Fa-f]+)$/;

export function parseLsn(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value !== 'string') {
    throw new TypeError(`无法解析 LSN: ${String(value)}`);
  }
  const match = LSN_RE.exec(value.trim());
  if (!match) {
    throw new Error(`非法 LSN 格式: ${value}，期望 "X/Y" 十六进制形式`);
  }
  return (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`);
}

export function formatLsn(lsn) {
  const value = parseLsn(lsn);
  const hi = value >> 32n;
  const lo = value & 0xffffffffn;
  return `${hi.toString(16).toUpperCase()}/${lo.toString(16).toUpperCase()}`;
}

export function compareLsn(a, b) {
  const x = parseLsn(a);
  const y = parseLsn(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function minLsn(a, b) {
  return compareLsn(a, b) <= 0 ? a : b;
}

export function maxLsn(a, b) {
  return compareLsn(a, b) >= 0 ? a : b;
}

export function lsnDistance(a, b) {
  const diff = parseLsn(b) - parseLsn(a);
  return diff < 0n ? -diff : diff;
}
