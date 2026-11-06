'use strict';

/** hub/web 静态文件服务：路径穿越防护 + MIME + `/` 与 `/m` 约定。 */

const fs = require('node:fs');
const path = require('node:path');

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
});

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function existsFile(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function sendFile(req, res, filePath) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': mimeFor(filePath),
    'Content-Length': stat.size,
    'Cache-Control': ['.html','.htm','.js','.css'].includes(ext) ? 'no-cache' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise((resolve) => {
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      try {
        res.destroy();
      } catch {
        /* 忽略 */
      }
      resolve();
    });
    stream.on('end', resolve);
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
  return true;
}

/**
 * 尝试响应静态资源。
 * @returns {Promise<boolean>} 是否已响应
 */
async function serveStatic(hub, req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const webDir = path.resolve(hub.webDir);

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.includes('\0')) return false;

  if (decoded === '/' || decoded === '') {
    return sendFile(req, res, path.join(webDir, 'index.html'));
  }
  if (decoded === '/m' || decoded === '/m/') {
    const mobile = path.join(webDir, 'm', 'index.html');
    if (await existsFile(mobile)) return sendFile(req, res, mobile);
    return sendFile(req, res, path.join(webDir, 'index.html'));
  }

  const relative = decoded.replace(/^\/+/, '');
  const full = path.resolve(webDir, relative);
  // 路径穿越防护：解析后的绝对路径必须仍在 web 根目录内
  if (full !== webDir && !full.startsWith(webDir + path.sep)) return false;
  return sendFile(req, res, full);
}

module.exports = { serveStatic, mimeFor, MIME_TYPES };

