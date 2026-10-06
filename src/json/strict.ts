/**
 * 严格 JSON 解析：只接受一个自洽的对象，重复键直接拒绝。
 *
 * 模型回答只允许是 `{"choice": N}`，旧实现用 Python 的 `object_pairs_hook` 拦住
 * `{"choice":1,"choice":2}` 这类被最后一个键悄悄覆盖的答案。`JSON.parse` 看不到重复键，
 * 所以这里保留一个小型递归下降解析器，代价是几十行，收益是「模型输出了什么」这件事
 * 不会被解析器悄悄改写。
 */

import type { JsonValue } from "./canonical.js";
import { isJsonObject, type JsonObject } from "./guards.js";
import { err, ok, type Result } from "../domain/result.js";

export type StrictJsonError = "duplicate_key" | "invalid_json";

class StrictParser {
  #index = 0;
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  parseObject(): Result<JsonObject, StrictJsonError> {
    this.#skipWhitespace();
    const value = this.#parseValue();
    if (!value.ok) return value;
    this.#skipWhitespace();
    if (this.#index !== this.#text.length) return err("invalid_json");
    if (!isJsonObject(value.value)) return err("invalid_json");
    return ok(value.value);
  }

  #parseValue(): Result<JsonValue, StrictJsonError> {
    this.#skipWhitespace();
    const head = this.#text[this.#index];
    if (head === undefined) return err("invalid_json");
    if (head === "{") return this.#parseRecord();
    if (head === "[") return this.#parseArray();
    if (head === '"') {
      const text = this.#parseString();
      return text.ok ? ok(text.value) : text;
    }
    return this.#parseLiteral();
  }

  #parseRecord(): Result<Record<string, JsonValue>, StrictJsonError> {
    this.#index += 1;
    const record: Record<string, JsonValue> = {};
    this.#skipWhitespace();
    if (this.#text[this.#index] === "}") {
      this.#index += 1;
      return ok(record);
    }
    for (;;) {
      this.#skipWhitespace();
      if (this.#text[this.#index] !== '"') return err("invalid_json");
      const key = this.#parseString();
      if (!key.ok) return key;
      if (Object.hasOwn(record, key.value)) return err("duplicate_key");
      this.#skipWhitespace();
      if (this.#text[this.#index] !== ":") return err("invalid_json");
      this.#index += 1;
      const value = this.#parseValue();
      if (!value.ok) return value;
      record[key.value] = value.value;
      this.#skipWhitespace();
      const next = this.#text[this.#index];
      if (next === ",") {
        this.#index += 1;
        continue;
      }
      if (next === "}") {
        this.#index += 1;
        return ok(record);
      }
      return err("invalid_json");
    }
  }

  #parseArray(): Result<JsonValue[], StrictJsonError> {
    this.#index += 1;
    const items: JsonValue[] = [];
    this.#skipWhitespace();
    if (this.#text[this.#index] === "]") {
      this.#index += 1;
      return ok(items);
    }
    for (;;) {
      const value = this.#parseValue();
      if (!value.ok) return value;
      items.push(value.value);
      this.#skipWhitespace();
      const next = this.#text[this.#index];
      if (next === ",") {
        this.#index += 1;
        continue;
      }
      if (next === "]") {
        this.#index += 1;
        return ok(items);
      }
      return err("invalid_json");
    }
  }

  #parseString(): Result<string, StrictJsonError> {
    this.#index += 1;
    let text = "";
    for (;;) {
      const head = this.#text[this.#index];
      if (head === undefined) return err("invalid_json");
      if (head === '"') {
        this.#index += 1;
        return ok(text);
      }
      if (head === "\\") {
        this.#index += 1;
        const escaped = this.#parseEscape();
        if (!escaped.ok) return escaped;
        text += escaped.value;
        continue;
      }
      if (head < " ") return err("invalid_json");
      text += head;
      this.#index += 1;
    }
  }

  #parseEscape(): Result<string, StrictJsonError> {
    const head = this.#text[this.#index];
    this.#index += 1;
    switch (head) {
      case '"':
        return ok('"');
      case "\\":
        return ok("\\");
      case "/":
        return ok("/");
      case "b":
        return ok("\b");
      case "f":
        return ok("\f");
      case "n":
        return ok("\n");
      case "r":
        return ok("\r");
      case "t":
        return ok("\t");
      case "u": {
        const digits = this.#text.slice(this.#index, this.#index + 4);
        if (!/^[0-9A-Fa-f]{4}$/.test(digits)) return err("invalid_json");
        this.#index += 4;
        return ok(String.fromCharCode(Number.parseInt(digits, 16)));
      }
      default:
        return err("invalid_json");
    }
  }

  /** JSON 没有 NaN/Infinity；Python 的 json.loads 接受它们，但旧实现随后也会拒掉这种答案。 */
  #parseLiteral(): Result<JsonValue, StrictJsonError> {
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (this.#text.startsWith(literal, this.#index)) {
        this.#index += literal.length;
        return ok(value);
      }
    }
    return this.#parseNumber();
  }

  #parseNumber(): Result<number, StrictJsonError> {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.#text.slice(this.#index));
    if (match === null) return err("invalid_json");
    const literal = match[0];
    this.#index += literal.length;
    const value = Number(literal);
    if (!Number.isFinite(value)) return err("invalid_json");
    return ok(value);
  }

  #skipWhitespace(): void {
    while (/[ \t\n\r]/.test(this.#text[this.#index] ?? "")) this.#index += 1;
  }
}

export function parseStrictObject(text: string): Result<JsonObject, StrictJsonError> {
  if (text.length === 0) return err("invalid_json");
  return new StrictParser(text).parseObject();
}