'use strict';

/**
 * 头脑风暴附件读取：把 Hub 本机路径或前端上传的文本，变成注入提示词的文件片段。
 *
 * 设计取舍：
 * - 用户明确要求“最大读取权限”，所以不限制目录；但反过来说，绝不能把密钥/凭据
 *   原文塞进模型上下文或持久化，因此仍拒绝常见敏感文件名。
 * - 只读文本：二进制（图片/压缩包/可执行文件）会被明确拒绝，避免上下文乱码。
 * - 单文件与总量都设上限：失败时返回 errors，调用方把错误写进提示词，不影响对话。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_ATTACHMENTS = 8;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TEXT_PER_FILE = 60000;
const MAX_UPLOAD_TEXT = 200000;
const MAX_TOTAL_CHARS = 160000;

/** 疑似密钥/凭据文件名：拒绝读取，避免把私密内容送进模型或存档。 */
const SENSITIVE_BASENAMES = [
  /^\.env(\.|$)/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^(credentials|secrets?|tokens?|passwords?)(\.[a-z0-9]+)?$/i,
];

const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.kdbx', '.jks', '.keystore'];

function isSensitivePath(target) {
  const base = path.basename(String(target || '')).toLowerCase();
  if (!base) return false;
  if (SENSITIVE_BASENAMES.some((pattern) => pattern.test(base))) return true;
  const ext = path.extname(base);
  return SENSITIVE_EXTENSIONS.includes(ext);
}

/** 粗略判断文本：含 NUL 或 UTF-8 解码出现大量替换字符即视为二进制。 */
function isProbablyText(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const head = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (head.includes(0)) return false;
  const text = buffer.toString('utf8');
  const replacement = (text.match(/\uFFFD/g) || []).length;
  return replacement / Math.max(1, text.length) < 0.02;
}

function decodeText(buffer) {
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

/**
 * 读取单个本机文件。
 * @returns {{ok:true,name:string,path:string,size:number,text:string,truncated:boolean}|{ok:false,path:string,name:string,error:string}}
 */
function readTextFile(target, options = {}) {
  const rawPath = String(target || '').trim();
  const name = path.basename(rawPath) || 'file';
  const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(options.cwd || process.cwd(), rawPath);
  if (!rawPath) return { ok: false, path: '', name, error: '缺少文件路径' };
  if (isSensitivePath(resolved)) {
    return { ok: false, path: resolved, name, error: '出于安全考虑，不读取疑似密钥/凭据文件' };
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, path: resolved, name, error: '文件不存在或无法访问' };
  }
  if (!stat.isFile()) return { ok: false, path: resolved, name, error: '不是文件（可能是目录）' };
  const limit = Math.min(MAX_FILE_BYTES, Number(options.maxBytes) || MAX_FILE_BYTES);
  const truncated = stat.size > limit;
  let buffer;
  try {
    const fd = fs.openSync(resolved, 'r');
    try {
      buffer = Buffer.alloc(Math.min(stat.size, limit));
      fs.readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { ok: false, path: resolved, name, error: '读取失败（权限或文件被占用）' };
  }
  if (!isProbablyText(buffer)) return { ok: false, path: resolved, name, error: '不是文本文件（二进制内容）' };
  let text = decodeText(buffer);
  if (text.length > MAX_TEXT_PER_FILE) text = `${text.slice(0, MAX_TEXT_PER_FILE)}\n…（已截断）`;
  return { ok: true, name, path: resolved, size: stat.size, text, truncated };
}

/** 前端上传的文本附件。 */
function readUploadedAttachment(item) {
  const name = path.basename(String(item && item.name ? item.name : 'attachment').trim()) || 'attachment';
  const text = String((item && item.text) || '');
  if (!text.trim()) return { ok: false, path: '', name, error: '文件内容为空' };
  if (text.length > MAX_UPLOAD_TEXT) {
    return { ok: false, path: '', name, error: `文件太大（上限 ${Math.floor(MAX_UPLOAD_TEXT / 1000)}KB 文本）` };
  }
  return { ok: true, name, path: '', size: Buffer.byteLength(text, 'utf8'), text, truncated: false };
}

/**
 * 归一化并读取附件列表：既支持本机路径 {path}，也支持上传内容 {name,text}。
 * 最多 8 个；总量超出时按顺序截断并标记。
 * @returns {{attachments:Array, errors:Array<string>}}
 */
function readAttachments(list, options = {}) {
  const attachments = [];
  const errors = [];
  const items = Array.isArray(list) ? list.slice(0, MAX_ATTACHMENTS) : [];
  let total = 0;
  for (const item of items) {
    let result;
    if (item && typeof item === 'object' && typeof item.path === 'string' && item.path.trim()) {
      result = readTextFile(item.path, options);
    } else if (item && typeof item === 'object' && typeof item.text === 'string') {
      result = readUploadedAttachment(item);
    } else {
      errors.push('附件格式无效（需要 {path} 或 {name,text}）');
      continue;
    }
    if (!result.ok) {
      errors.push(`${result.name}${result.path ? `（${result.path}）` : ''}：${result.error}`);
      continue;
    }
    const remaining = MAX_TOTAL_CHARS - total;
    if (remaining <= 0) {
      errors.push(`${result.name}：超出附件总长度上限，已跳过`);
      continue;
    }
    let text = result.text;
    let truncated = result.truncated;
    if (text.length > remaining) {
      text = `${text.slice(0, remaining)}\n…（附件总量超限，已截断）`;
      truncated = true;
    }
    total += text.length;
    attachments.push({
      name: result.name,
      path: result.path,
      size: result.size,
      text,
      truncated: Boolean(truncated),
    });
  }
  return { attachments, errors };
}

/**
 * 从消息正文里提取存在的本机文件路径（绝对路径/UNC）。
 * 支持引号包裹与裸路径；只返回能读到文本的文件。
 */
function extractFilePaths(text, options = {}) {
  const source = String(text || '');
  const candidates = new Set();
  const quoted = /["'`]((?:[A-Za-z]:\\|\\\\|\/)[^"'`\r\n]{2,})["'`]/g;
  // 前置字符排除字母/数字/路径字符，让「文件：C:\...」「路径（C:\...）」等中文语境也能命中。
  const windows = /(?:^|[^A-Za-z0-9._\-\\/])([A-Za-z]:\\[^\s"'`<>|*?\r\n]+)/g;
  const unc = /(?:^|[^A-Za-z0-9._\-\\/])(\\\\[^\s"'`<>|*?\r\n]+)/g;
  const unix = /(?:^|[^A-Za-z0-9._\-/])(\/[A-Za-z0-9._\-/]{3,})/g;
  for (const pattern of [quoted, windows, unc, unix]) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]) candidates.add(match[1]);
    }
  }
  const requireExists = options.requireExists !== false;
  const found = [];
  for (let candidate of candidates) {
    candidate = candidate.replace(/[.,;:!?)\]}>）)。，；：！？]+$/g, '').trim();
    if (!candidate) continue;
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(options.cwd || process.cwd(), candidate);
    if (!requireExists) {
      // 只用于判断「本轮是否在谈文件」：不检查存在性/敏感/二进制，交给读取阶段给出具体错误。
      if (!found.includes(resolved)) found.push(resolved);
      continue;
    }
    if (isSensitivePath(candidate)) continue;
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (!looksLikeTextFile(resolved)) continue;
    found.push(resolved);
  }
  return found;
}

/** 读取文件头判断是否为文本，避免把图片/压缩包等二进制路径当附件。 */
function looksLikeTextFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(Math.min(4096, Math.max(1, fs.fstatSync(fd).size)));
    if (buffer.length === 0) return true;
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    return isProbablyText(buffer);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 生成任务/消息里可持久化的附件元数据（不保存正文）。 */
function attachmentMeta(attachment) {
  return {
    name: String(attachment.name || path.basename(attachment.path || '') || 'file'),
    ...(attachment.path ? { path: attachment.path } : {}),
    size: Number(attachment.size) || 0,
    ...(attachment.truncated ? { truncated: true } : {}),
  };
}

module.exports = {
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  MAX_TEXT_PER_FILE,
  MAX_UPLOAD_TEXT,
  MAX_TOTAL_CHARS,
  attachmentMeta,
  extractFilePaths,
  isProbablyText,
  isSensitivePath,
  readAttachments,
  readTextFile,
  readUploadedAttachment,
};
