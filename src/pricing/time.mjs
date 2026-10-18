// 时间戳解析，移植自 ccusage 20.0.21 rust/crates/ccusage-core/src/date_utils.rs（MIT）。
export const MILLIS_PER_SECOND = 1000;
export const MILLIS_PER_MINUTE = 60 * MILLIS_PER_SECOND;
export const MILLIS_PER_HOUR = 60 * MILLIS_PER_MINUTE;
export const MILLIS_PER_DAY = 24 * MILLIS_PER_HOUR;

const digitsAt = (text, from, to) => {
  let value = 0;
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return null;
    value = value * 10 + (c - 0x30);
  }
  return value;
};

const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const daysInMonth = (year, month) => (month === 2 && isLeapYear(year) ? 29 : DAYS[month - 1]);

// Howard Hinnant days_from_civil，与上游同一算法。
function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function timezoneOffset(text, start) {
  const tail = text.slice(start);
  if (tail === 'Z') return 0;
  if (tail.length !== 6 || (tail[0] !== '+' && tail[0] !== '-') || tail[3] !== ':') return null;
  const hours = digitsAt(tail, 1, 3);
  const minutes = digitsAt(tail, 4, 6);
  if (hours === null || minutes === null || hours > 23 || minutes > 59) return null;
  const offset = hours * 60 + minutes;
  return tail[0] === '+' ? offset : -offset;
}

/**
 * `parse_ts_timestamp`：只接受 `YYYY-MM-DDTHH:MM:SS[.mmm](Z|±HH:MM)` 四种定长格式，返回毫秒时间戳或 null。
 */
export function parseTsTimestamp(value) {
  if (typeof value !== 'string' || /[^\x00-\x7f]/.test(value)) return null;
  const n = value.length;
  let millis;
  let tzStart;
  if ((n === 20 || n === 25) && (value[19] === 'Z' || value[19] === '+' || value[19] === '-')) {
    millis = 0;
    tzStart = 19;
  } else if ((n === 24 || n === 29) && value[19] === '.') {
    millis = digitsAt(value, 20, 23);
    if (millis === null) return null;
    tzStart = 23;
  } else {
    return null;
  }
  if (
    value[4] !== '-' ||
    value[7] !== '-' ||
    value[10] !== 'T' ||
    value[13] !== ':' ||
    value[16] !== ':'
  ) {
    return null;
  }
  const year = digitsAt(value, 0, 4);
  const month = digitsAt(value, 5, 7);
  const day = digitsAt(value, 8, 10);
  const hour = digitsAt(value, 11, 13);
  const minute = digitsAt(value, 14, 16);
  const second = digitsAt(value, 17, 19);
  if ([year, month, day, hour, minute, second].includes(null)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const offset = timezoneOffset(value, tzStart);
  if (offset === null) return null;
  if (month < 1 || month > 12 || day === 0 || day > daysInMonth(year, month)) return null;
  return (
    daysFromCivil(year, month, day) * MILLIS_PER_DAY +
    hour * MILLIS_PER_HOUR +
    minute * MILLIS_PER_MINUTE +
    second * MILLIS_PER_SECOND +
    millis -
    offset * MILLIS_PER_MINUTE
  );
}

/** 毫秒时间戳的 UTC 日期 `YYYY-MM-DD`，作为 Codex 分组的默认周期。 */
export function utcDate(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}
