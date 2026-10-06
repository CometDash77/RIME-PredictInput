/**
 * 本地 HTTP 传输层。
 *
 * 三条安全约束在这里一次写清：不跟随重定向（认证留在固定源上）、不使用系统代理
 * （本地回环不该被代理劫持）、响应体有硬上限（避免被一个坏服务把内存吃掉）。
 */

import { err, ok, type Result } from "../domain/result.js";
import type { HttpFailureCode, TransportFailureCode } from "../domain/error-codes.js";

export const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface HttpResponse {
  readonly status: number;
  readonly body: Uint8Array;
}

export interface HttpRequestOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly timeoutSeconds?: number;
}

export interface HttpTransportLike {
  request(
    method: string,
    url: string,
    options?: HttpRequestOptions,
  ): Promise<Result<HttpResponse, TransportFailureCode>>;
}

/** 旧实现把服务端文本映射成一个固定枚举，绝不回显服务端说了什么。 */
export function safeHttpError(status: number): HttpFailureCode {
  if (status === 401) return "unauthorized";
  if (status === 402) return "payment_required";
  if (status === 403) return "forbidden";
  if (status === 404) return "model_unavailable";
  if (status === 422) return "invalid_request";
  if (status === 429) return "rate_limited";
  if (status === 529) return "provider_overloaded";
  if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) return "redirect_refused";
  if (status >= 500) return "provider_unavailable";
  if (status >= 400) return "provider_rejected";
  return "provider_error";
}

function isTimeout(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function readBounded(response: Response): Promise<Result<Uint8Array, TransportFailureCode>> {
  const stream = response.body;
  if (stream === null) return ok(new Uint8Array(0));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return err("response_too_large");
      }
      chunks.push(value);
    }
  } catch {
    return err("network_unavailable");
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return ok(body);
}

export class FetchTransport implements HttpTransportLike {
  async request(
    method: string,
    url: string,
    options: HttpRequestOptions = {},
  ): Promise<Result<HttpResponse, TransportFailureCode>> {
    const timeoutMs = Math.max(1, Math.round((options.timeoutSeconds ?? 3) * 1000));
    const signal = AbortSignal.timeout(timeoutMs);
    const init: RequestInit = {
      method,
      headers: { ...options.headers },
      // 手工处理重定向：3xx 必须原样回到上层并被映射成 redirect_refused。
      redirect: "manual",
      signal,
    };
    if (options.body !== undefined) init.body = options.body;
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      return err(isTimeout(error, signal) ? "timeout" : "network_unavailable");
    }
    const body = await readBounded(response);
    if (!body.ok) return body;
    return ok({ status: response.status, body: body.value });
  }
}

/** Python 的 json.loads(body.decode()) 等价物：只用于服务端返回的 JSON 体。 */
export function decodeJsonBody(body: Uint8Array): Result<unknown, "invalid_json"> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return err("invalid_json");
  }
  try {
    return ok(JSON.parse(text));
  } catch {
    return err("invalid_json");
  }
}
