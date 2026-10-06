/**
 * Canonical JSON encoders with byte-for-byte parity to Python's `json.dumps`.
 *
 * The legacy sidecar is the reference implementation of the request/response
 * files and of every digest that identifies a policy, a model or a cached
 * decision. Anything that reaches Lua must keep those bytes stable, so this
 * module reproduces the four encoders the Python code actually used:
 *
 *   compact      json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
 *   sortedCompact json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
 *   sortedDefault json.dumps(value, ensure_ascii=False, sort_keys=True)   // ", " / ": "
 *   indented     json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export class JsonEncodingError extends Error {
  readonly reason: "unsupported_type" | "non_finite_number";

  constructor(reason: "unsupported_type" | "non_finite_number") {
    super(reason === "unsupported_type" ? "value is not JSON-encodable" : "number is not finite");
    this.name = "JsonEncodingError";
    this.reason = reason;
  }
}

interface EncoderOptions {
  readonly sortKeys: boolean;
  readonly indent: number | null;
  readonly itemSeparator: string;
  readonly keySeparator: string;
}

const COMPACT: EncoderOptions = { sortKeys: false, indent: null, itemSeparator: ",", keySeparator: ":" };
const SORTED_COMPACT: EncoderOptions = { sortKeys: true, indent: null, itemSeparator: ",", keySeparator: ":" };
const SORTED_DEFAULT: EncoderOptions = { sortKeys: true, indent: null, itemSeparator: ", ", keySeparator: ": " };
const INDENTED: EncoderOptions = { sortKeys: false, indent: 2, itemSeparator: ",", keySeparator: ": " };
const DEFAULT_SEPARATORS: EncoderOptions = { sortKeys: false, indent: null, itemSeparator: ", ", keySeparator: ": " };

/** Python's `str`/`repr` for a number, matching `json.dumps` output. */
export function pythonNumber(value: number): string {
  if (!Number.isFinite(value)) throw new JsonEncodingError("non_finite_number");
  if (Number.isInteger(value) && Object.is(value, -0) === false) return value.toFixed(0);
  if (Object.is(value, -0)) return "0";
  const text = String(value);
  // Python writes exponents with a sign and at least two digits: 1e-07, 1e+21.
  const match = /^(?<mantissa>-?\d+(?:\.\d+)?)e(?<sign>[+-])(?<digits>\d+)$/.exec(text);
  if (match === null) return text;
  const { mantissa, sign, digits } = match.groups as { mantissa: string; sign: string; digits: string };
  return `${mantissa}e${sign}${digits.padStart(2, "0")}`;
}

function escapeString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    switch (char) {
      case '"':
        out += '\\"';
        continue;
      case "\\":
        out += "\\\\";
        continue;
      case "\b":
        out += "\\b";
        continue;
      case "\f":
        out += "\\f";
        continue;
      case "\n":
        out += "\\n";
        continue;
      case "\r":
        out += "\\r";
        continue;
      case "\t":
        out += "\\t";
        continue;
      default:
        break;
    }
    if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += char;
  }
  return out + '"';
}

/** Code-point ordering, like Python's `sort_keys`; `Array#sort` compares UTF-16 units. */
export function compareCodePoints(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = (a[index] as string).codePointAt(0)! - (b[index] as string).codePointAt(0)!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function encodeValue(value: unknown, options: EncoderOptions, depth: number): string {
  if (depth > 64) throw new JsonEncodingError("unsupported_type");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return pythonNumber(value);
    case "string":
      return escapeString(value);
    case "undefined":
      throw new JsonEncodingError("unsupported_type");
    default:
      break;
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => encodeValue(item, options, depth + 1));
    return parts.length === 0 ? "[]" : `[${parts.join(options.itemSeparator)}${options.indent === null ? "" : "\n" + " ".repeat(options.indent * (depth + 1) - options.indent)}]`;
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source);
    if (options.sortKeys) keys.sort(compareCodePoints);
    const indent = options.indent;
    const parts = keys.map((key) => {
      const encoded = encodeValue(source[key], options, depth + 1);
      return indent === null ? `${escapeString(key)}${options.keySeparator}${encoded}` : `${escapeString(key)}${options.keySeparator}${encoded}`;
    });
    if (parts.length === 0) return "{}";
    if (indent === null) return `{${parts.join(options.itemSeparator)}}`;
    const pad = " ".repeat(indent * (depth + 1));
    const closing = " ".repeat(indent * depth);
    return `{\n${parts.map((part) => pad + part).join(",\n")}\n${closing}}`;
  }
  throw new JsonEncodingError("unsupported_type");
}

export function compact(value: JsonValue): string {
  return encodeValue(value, COMPACT, 0);
}

export function sortedCompact(value: JsonValue): string {
  return encodeValue(value, SORTED_COMPACT, 0);
}

export function sortedDefault(value: JsonValue): string {
  return encodeValue(value, SORTED_DEFAULT, 0);
}

export function indented(value: JsonValue): string {
  return encodeValue(value, INDENTED, 0);
}

/** `json.dumps(value, ensure_ascii=False)`: insertion order, ", " and ": " separators. */
export function defaultSeparators(value: JsonValue): string {
  return encodeValue(value, DEFAULT_SEPARATORS, 0);
}

export function compactBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(compact(value));
}
