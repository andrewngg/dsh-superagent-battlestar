'use strict';

/**
 * 统一错误格式：{ error: { code, message } }
 * 见 docs/PROTOCOL.md §2。HTTP 状态码由 code 映射。
 */

const STATUS_BY_CODE = Object.freeze({
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  bad_request: 400,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
});

class HttpError extends Error {
  constructor(code, message) {
    const finalCode = STATUS_BY_CODE[code] ? code : 'internal';
    super(message || finalCode);
    this.name = 'HttpError';
    this.code = finalCode;
    this.status = STATUS_BY_CODE[finalCode];
  }
}

function unauthorized(message = '未授权') {
  return new HttpError('unauthorized', message);
}

function forbidden(message = '无权限') {
  return new HttpError('forbidden', message);
}

function notFound(message = '资源不存在') {
  return new HttpError('not_found', message);
}

function badRequest(message = '请求参数错误') {
  return new HttpError('bad_request', message);
}

function conflict(message = '状态冲突') {
  return new HttpError('conflict', message);
}

/** 将任意异常收敛为 HttpError；未知异常不把堆栈泄漏给客户端。 */
function toHttpError(err) {
  if (err instanceof HttpError) return err;
  if (err && err.name === 'AbortError') return new HttpError('bad_request', '请求已取消');
  return new HttpError('internal', '服务器内部错误');
}

module.exports = {
  STATUS_BY_CODE,
  HttpError,
  unauthorized,
  forbidden,
  notFound,
  badRequest,
  conflict,
  toHttpError,
};
