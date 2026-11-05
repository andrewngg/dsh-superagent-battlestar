'use strict';

/**
 * JSON 状态持久化：原子写（写 tmp 后 rename）+ 防抖。
 * 任何写失败只告警，不阻塞 Hub 运行。
 */

const fs = require('node:fs');
const path = require('node:path');

class StateStore {
  /**
   * @param {string} file 目标文件（如 hub/data/state.json）
   * @param {() => object} getState 返回可序列化快照
   * @param {{ debounceMs?: number, onError?: (err: Error) => void }} [options]
   */
  constructor(file, getState, options = {}) {
    this.file = file;
    this.getState = getState;
    this.debounceMs = Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : 150;
    this.onError = typeof options.onError === 'function' ? options.onError : () => {};
    this._timer = null;
    this._chain = Promise.resolve();
    this._closed = false;
  }

  /** 读取持久化状态；文件不存在或损坏时返回 null。 */
  async load() {
    let raw;
    try {
      raw = await fs.promises.readFile(this.file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      this.onError(err);
      return null;
    }
    try {
      const data = JSON.parse(raw);
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (err) {
      this.onError(err);
      return null;
    }
  }

  /** 防抖调度一次写入。 */
  schedule() {
    if (this._closed || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._enqueueWrite();
    }, this.debounceMs);
    if (this._timer.unref) this._timer.unref();
  }

  /** 立即落盘并等待完成。 */
  async flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._enqueueWrite();
    await this._chain;
  }

  async close() {
    this._closed = true;
    await this.flush();
  }

  _enqueueWrite() {
    this._chain = this._chain
      .then(() => this._write())
      .catch((err) => {
        this.onError(err);
      });
    return this._chain;
  }

  async _write() {
    const json = `${JSON.stringify(this.getState(), null, 2)}\n`;
    const dir = path.dirname(this.file);
    await fs.promises.mkdir(dir, { recursive: true });
    // 同目录写临时文件再 rename，保证读取方不会看到半截 JSON
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    try {
      await fs.promises.writeFile(tmp, json, 'utf8');
      await fs.promises.rename(tmp, this.file);
    } catch (err) {
      try {
        await fs.promises.rm(tmp, { force: true });
      } catch {
        /* 忽略清理失败 */
      }
      throw err;
    }
  }
}

module.exports = { StateStore };
