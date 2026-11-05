'use strict';

/**
 * Hub API 客户端：封装鉴权头、错误格式、长轮询超时。
 * 只依赖 docs/PROTOCOL.md 中的 HTTP 契约，不 require hub 内部代码。
 */

const { requestJson, joinUrl, normalizeBaseUrl } = require('./http');

const DEFAULT_TIMEOUT_MS = 15000;
const LONG_POLL_PADDING_MS = 8000;
const MAX_LONG_POLL_MS = 30000;

class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status || 0;
    this.code = options.code || 'api_error';
    this.body = options.body === undefined ? null : options.body;
    this.url = options.url || '';
  }

  /** 令牌失效、设备被删除等需要重新注册的情况。 */
  get isAuthError() {
    return this.status === 401 || this.status === 403 || this.status === 404;
  }

  get isNetworkError() {
    return !this.status;
  }
}

class HubClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl
   * @param {string} [options.deviceId]
   * @param {string} [options.deviceToken]
   * @param {string} [options.joinCode]
   * @param {string} [options.adminToken]
   * @param {number} [options.timeoutMs]
   */
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || 'http://127.0.0.1:7317');
    this.deviceId = options.deviceId || null;
    this.deviceToken = options.deviceToken || null;
    this.joinCode = options.joinCode || null;
    this.adminToken = options.adminToken || null;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  setDevice(deviceId, deviceToken) {
    this.deviceId = deviceId || null;
    this.deviceToken = deviceToken || null;
  }

  resolve(pathname) {
    return joinUrl(this.baseUrl, pathname);
  }

  /**
   * 发起一次请求；非 2xx 抛 ApiError（保留 hub 的 error.code）。
   * @param {string} pathname
   * @param {object} [options]
   */
  async request(pathname, options = {}) {
    const {
      method = 'GET',
      body,
      headers = {},
      timeoutMs = this.timeoutMs,
      signal,
      auth = 'auto',
      admin = false,
    } = options;

    const requestHeaders = { ...headers };
    if (admin || auth === 'admin') {
      if (this.adminToken) requestHeaders['x-butler-token'] = this.adminToken;
    } else if (auth === 'device' || (auth === 'auto' && this.deviceToken)) {
      if (this.deviceToken) requestHeaders['x-butler-device-token'] = this.deviceToken;
    }
    if (auth === 'join' && this.joinCode) requestHeaders['x-butler-join-code'] = this.joinCode;

    const url = this.resolve(pathname);
    let response;
    try {
      response = await requestJson(url, { method, body, headers: requestHeaders, timeoutMs, signal });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      const apiErr = new ApiError(err.message, { code: err.code || 'network_error', url });
      apiErr.cause = err;
      throw apiErr;
    }

    if (response.status >= 200 && response.status < 300) return response;

    const errorBody = response.json && typeof response.json === 'object' ? response.json : null;
    const code = errorBody && errorBody.error && errorBody.error.code ? errorBody.error.code : `http_${response.status}`;
    const message =
      (errorBody && errorBody.error && errorBody.error.message) ||
      `${method} ${pathname} 失败：HTTP ${response.status}`;
    throw new ApiError(message, {
      status: response.status,
      code,
      body: response.json,
      url,
    });
  }

  async health(timeoutMs = 3000) {
    return this.request('/api/health', { timeoutMs });
  }

  /**
   * 注册 / 恢复注册（§5.2）。
   * @param {object} manifest
   * @param {object} [options]
   * @param {string} [options.joinCode]
   * @param {string} [options.deviceId] 已注册设备 id
   * @param {string} [options.deviceToken] 已注册设备令牌
   */
  async register(manifest, options = {}) {
    const headers = {};
    const joinCode = options.joinCode || this.joinCode;
    if (joinCode) headers['x-butler-join-code'] = joinCode;
    if (options.deviceId) headers['x-butler-device-id'] = options.deviceId;
    if (options.deviceToken) headers['x-butler-device-token'] = options.deviceToken;
    const body = { ...manifest };
    if (options.deviceId) body.deviceId = options.deviceId;
    return this.request('/api/devices/register', { method: 'POST', body, headers, timeoutMs: this.timeoutMs });
  }

  async updateManifest(manifest) {
    const id = this.deviceId;
    if (!id) throw new ApiError('尚未注册设备，无法更新 manifest', { code: 'not_registered' });
    return this.request(`/api/devices/${encodeURIComponent(id)}/manifest`, {
      method: 'POST',
      body: manifest,
      auth: 'device',
    });
  }

  async heartbeat(payload, options = {}) {
    const id = this.deviceId;
    if (!id) throw new ApiError('尚未注册设备，无法发送心跳', { code: 'not_registered' });
    return this.request(`/api/devices/${encodeURIComponent(id)}/heartbeat`, {
      method: 'POST',
      body: payload,
      auth: 'device',
      signal: options.signal,
      timeoutMs: options.timeoutMs || this.timeoutMs,
    });
  }

  /**
   * 长轮询领取命令（§5.3）。
   * @param {{waitMs?:number, limit?:number, signal?:AbortSignal}} [options]
   */
  async pollCommands(options = {}) {
    const id = this.deviceId;
    if (!id) throw new ApiError('尚未注册设备，无法领取命令', { code: 'not_registered' });
    const waitMs = Math.max(0, Math.min(MAX_LONG_POLL_MS, Number(options.waitMs) || 0));
    const limit = Math.max(1, Math.min(8, Number(options.limit) || 5));
    return this.request(
      `/api/devices/${encodeURIComponent(id)}/commands?waitMs=${waitMs}&limit=${limit}`,
      {
        method: 'GET',
        auth: 'device',
        timeoutMs: waitMs + LONG_POLL_PADDING_MS,
        signal: options.signal,
      },
    );
  }

  async ack(taskId) {
    const id = this.deviceId;
    if (!id) throw new ApiError('尚未注册设备，无法 ack', { code: 'not_registered' });
    return this.request(`/api/devices/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/ack`, {
      method: 'POST',
      body: { ok: true },
      auth: 'device',
      timeoutMs: this.timeoutMs,
    });
  }

  async progress(taskId, payload) {
    const id = this.deviceId;
    if (!id) throw new ApiError('尚未注册设备，无法上报进度', { code: 'not_registered' });
    return this.request(`/api/devices/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/progress`, {
      method: 'POST',
      body: payload,
      auth: 'device',
      timeoutMs: this.timeoutMs,
    });
  }

  async result(taskId, payload) {
    const id = this.deviceId;
    if (!id) throw new ApiError('尚未注册设备，无法上报结果', { code: 'not_registered' });
    return this.request(`/api/devices/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/result`, {
      method: 'POST',
      body: payload,
      auth: 'device',
      timeoutMs: this.timeoutMs,
    });
  }

  async unregister() {
    const id = this.deviceId;
    if (!id) return null;
    return this.request(`/api/devices/${encodeURIComponent(id)}/unregister`, {
      method: 'POST',
      body: {},
      auth: 'device',
      timeoutMs: 3000,
    });
  }

  // ---- 管理端（demo / 测试辅助） ----

  async snapshot(query = '') {
    return this.request(`/api/snapshot${query}`, { admin: true, timeoutMs: 5000 });
  }

  async listDevices() {
    return this.request('/api/devices', { admin: true, timeoutMs: 5000 });
  }

  async createTask(payload) {
    return this.request('/api/tasks', { method: 'POST', body: payload, admin: true, timeoutMs: 8000 });
  }
}

module.exports = { HubClient, ApiError, MAX_LONG_POLL_MS };
