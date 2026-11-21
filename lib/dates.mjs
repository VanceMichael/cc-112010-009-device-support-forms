/**
 * 资料源里的日期分为两种：
 *  - 纯日期（2026-11-28）表示医院所在地的业务日，按 +08:00 解释；
 *  - 带时区的时间戳原样解析。
 * 统一在这里处理，避免服务器时区不同把“当天结束”算错一天。
 */

export const BUSINESS_OFFSET = '+08:00'

export function parseDayStart(value) {
  if (!value) return null
  const text = value.length === 10 ? `${value}T00:00:00${BUSINESS_OFFSET}` : value
  const date = new Date(text)
  return Number.isFinite(date.valueOf()) ? date : null
}

export function parseDayEnd(value) {
  if (!value) return null
  const text = value.length === 10 ? `${value}T23:59:59.999${BUSINESS_OFFSET}` : value
  const date = new Date(text)
  return Number.isFinite(date.valueOf()) ? date : null
}

/** 是否严格晚于某业务日（用于“截止日已过”）。 */
export function afterDay(value, at) {
  const end = parseDayEnd(value)
  return Boolean(end) && at.getTime() > end.getTime()
}

export function inDayRange(from, through, at) {
  const start = parseDayStart(from)
  const end = parseDayEnd(through)
  if (start && at < start) return false
  if (end && at > end) return false
  return true
}
