// serde_json::Value 的最小子集与 to_string_pretty 输出（2 空格缩进，对象键按字节序，即
// 未开启 preserve_order 的 BTreeMap）。
import { compareBytes } from './text.mjs';
import { formatF64, jsonFloat } from './float.mjs';

/** 已经格式化好的数字字面量（用于区分 f64 与整数）。 */
export class JsonNumber {
  constructor(text) {
    this.text = text;
  }
}

/** 序列化成 f64（如 ModelBreakdown.cost，整数值写成 1.0）。 */
export const f64 = (value) => new JsonNumber(formatF64(value));

/** 经 json_float 处理的 f64（如 totalCost，整数值写成 1）。 */
export const floatOrInteger = (value) => new JsonNumber(jsonFloat(value));

function writeValue(value, indent) {
  if (value === null) return 'null';
  if (value instanceof JsonNumber) return value.text;
  switch (typeof value) {
    case 'string':
      // serde_json 只转义 " \ 与 C0 控制符（\b \f \n \r \t，其余 \u00xx 小写），与 JSON.stringify 相同。
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return String(value);
    case 'number':
      if (!Number.isInteger(value))
        throw new TypeError(`非整数的 number 需用 f64() 包装：${value}`);
      return Object.is(value, -0) ? '0' : String(value);
    case 'object':
      break;
    default:
      throw new TypeError(`无法序列化 ${typeof value}`);
  }
  const inner = indent + '  ';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => inner + writeValue(item, inner)).join(',\n')}\n${indent}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort(compareBytes);
  if (keys.length === 0) return '{}';
  const fields = keys.map(
    (key) => `${inner}${JSON.stringify(key)}: ${writeValue(value[key], inner)}`,
  );
  return `{\n${fields.join(',\n')}\n${indent}}`;
}

/** serde_json::to_string_pretty */
export const toPrettyJson = (value) => writeValue(value, '');

/** strip_cost_json：递归删除对象中的 totalCost、costUSD、cost。 */
export function stripCostJson(value) {
  if (Array.isArray(value)) value.forEach(stripCostJson);
  else if (value && typeof value === 'object' && !(value instanceof JsonNumber)) {
    delete value.totalCost;
    delete value.costUSD;
    delete value.cost;
    Object.values(value).forEach(stripCostJson);
  }
  return value;
}
