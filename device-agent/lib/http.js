'use strict';

/**
 * 零依赖 HTTP JSON 客户端（node:http / node:https）。
 * 只解析 JSON，不跟随重定向；网络错误/超时/取消统一抛错。
 */

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

class HttpRequestError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'HttpRequestError';
    this.code = options.code || 'network_error';
    this.url = options.url || '';
    if (options.status) this.status = options.status;
    if (options.cause) this.cause = options.cause;
  }
}

function abortError(signal) {
  const reason = signal && signal.reason;
  const err = new HttpRequestError(
    `请求已取消${typeof reason === 'string' ? `：${reason}` : ''}`,
    { code: 'aborted' },
  );
  err.name = 'AbortError';
  return err;
}

/**
 * POST/GET 一个 JSON 接口。
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string,string>} [options.headers]
 * @param {object|string|Buffer|null} [options.body] 对象会被 JSON 序列化
 * @param {number} [options.timeoutMs] 0 表示不设超时
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.maxResponseBytes]
 * @returns {Promise<{status:number, headers:object, json:any, text:string, url:string}>}
 */
function requestJson(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal = null,
    maxResponseBytes = MAX_RESPONSE_BYTES,
  } = options;

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new HttpRequestError(`无效 URL：${url}`, { code: 'bad_url', url }));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new HttpRequestError(`不支持的协议：${parsed.protocol}`, { code: 'bad_url', url }));
      return;
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const payload =
      body === null || body === undefined
        ? null
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');

    const requestHeaders = {
      accept: 'application/json',
      'user-agent': 'super-butler-agent/0.1.0',
      ...headers,
    };
    if (payload) {
      requestHeaders['content-type'] = requestHeaders['content-type'] || 'application/json; charset=utf-8';
      requestHeaders['content-length'] = String(payload.length);
    }

    let settled = false;
    let req = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };

    const onAbort = () => {
      if (settled) return;
      const err = abortError(signal);
      try {
        req.destroy(err);
      } catch {
        /* ignore */
      }
      finish(reject, err);
    };

    if (signal) {
      if (signal.aborted) {
        reject(abortError(signal));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      req = transport.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method,
          headers: requestHeaders,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxResponseBytes) {
              res.destroy();
              finish(
                reject,
                new HttpRequestError(`响应体超过上限 ${maxResponseBytes} 字节：${method} ${url}`, {
                  code: 'response_too_large',
                  url,
                }),
              );
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            if (text) {
              try {
                json = JSON.parse(text);
              } catch {
                json = null;
              }
            }
            finish(resolve, { status: res.statusCode || 0, headers: res.headers, json, text, url });
          });
          res.on('error', (err) => {
            finish(
              reject,
              new HttpRequestError(`读取响应失败：${err.message}`, { code: 'response_error', url, cause: err }),
            );
          });
        },
      );
    } catch (err) {
      finish(reject, new HttpRequestError(`创建请求失败：${err.message}`, { code: 'request_error', url, cause: err }));
      return;
    }

    req.on('error', (err) => {
      if (settled) return;
      const code = err && err.code === 'ECONNREFUSED' ? 'econnrefused' : 'network_error';
      const message =
        err instanceof HttpRequestError
          ? err.message
          : `请求失败：${method} ${url} — ${err && err.message ? err.message : String(err)}`;
      finish(reject, new HttpRequestError(message, { code, url, cause: err }));
    });

    req.on('timeout', () => {
      const err = new HttpRequestError(`请求超时 ${timeoutMs}ms：${method} ${url}`, {
        code: 'timeout',
        url,
      });
      try {
        req.destroy(err);
      } catch {
        /* ignore */
      }
      finish(reject, err);
    });

    if (timeoutMs > 0) req.setTimeout(timeoutMs);

    if (payload) req.write(payload);
    req.end();
  });
}

/** 拼接 baseUrl 与路径，避免出现双斜杠或丢失路径前缀。 */
function joinUrl(baseUrl, pathname) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = String(pathname || '').startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${suffix}`;
}

/** 规范化 Hub 地址：补 http://、去尾部斜杠。 */
function normalizeBaseUrl(input) {
  let value = String(input || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  return value.replace(/\/+$/, '');
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  HttpRequestError,
  requestJson,
  joinUrl,
  normalizeBaseUrl,
  abortError,
};
