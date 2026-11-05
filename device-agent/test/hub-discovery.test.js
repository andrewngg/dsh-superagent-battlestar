'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hubPortFromUrl, buildCandidates } = require('../lib/hub-discovery');

test('hubPortFromUrl：从 Hub URL 解析扫描端口', () => {
  assert.equal(hubPortFromUrl('http://192.168.1.6:7317'), 7317);
  assert.equal(hubPortFromUrl('https://hub.example:9443/'), 9443);
  assert.equal(hubPortFromUrl('http://192.168.1.6'), 7317);
  assert.equal(hubPortFromUrl('not a url', 8123), 8123);
});

test('buildCandidates：生成 /24 候选且排除本机回环地址', () => {
  const candidates = buildCandidates();
  assert.ok(Array.isArray(candidates));
  assert.ok(candidates.every((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)));
  assert.ok(candidates.every((ip) => !ip.startsWith('127.')));
  const unique = new Set(candidates);
  assert.equal(unique.size, candidates.length);
});
