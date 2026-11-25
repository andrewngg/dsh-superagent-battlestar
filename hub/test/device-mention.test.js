'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDeviceMention } = require('../lib/device-mention.js');

function makeDevices() {
  return [
    {
      id: 'dev_main',
      name: '主工作机 · DESKTOP-ABC123',
      nickname: '母机',
      platform: 'windows',
      tags: ['本机', '第一工作机', 'Hermes', 'OpenCode'],
    },
    {
      id: 'dev_mika',
      name: '手机工作机 · OPPO PDCM00',
      nickname: 'Mika手机',
      platform: 'android',
      tags: ['手机', 'Mika', '随身'],
    },
  ];
}

test('设备点名：昵称/标签命中，用 mika 工作机', () => {
  const devices = makeDevices();
  const mika = resolveDeviceMention('把 tracking 层的都处理掉。用mika工作机', devices);
  assert.ok(mika);
  assert.equal(mika.deviceId, 'dev_mika');

  const spaced = resolveDeviceMention('用 Mika 工作机跑一遍', devices);
  assert.ok(spaced);
  assert.equal(spaced.deviceId, 'dev_mika');

  const main = resolveDeviceMention('继续用母机跑', devices);
  assert.ok(main);
  assert.equal(main.deviceId, 'dev_main');
});

test('设备点名：唯一 Android 设备可用「手机」「安卓」指代', () => {
  const devices = makeDevices();
  for (const instruction of ['交给手机处理', '在安卓上执行', '用手机工作机连一下']) {
    const mention = resolveDeviceMention(instruction, devices);
    assert.ok(mention, instruction);
    assert.equal(mention.deviceId, 'dev_mika', instruction);
  }
});

test('设备点名：否定语境跳过，否定后点名别的设备仍生效', () => {
  const devices = makeDevices();
  const main = resolveDeviceMention('不要用 Mika，改用母机继续', devices);
  assert.ok(main);
  assert.equal(main.deviceId, 'dev_main');

  const onlyNegated = resolveDeviceMention('不要用 Mika', devices);
  assert.equal(onlyNegated, null);
});

test('设备点名：没有路由语境或只是词内片段时不认', () => {
  const devices = makeDevices();
  assert.equal(resolveDeviceMention('mika 的简历数据核对一下', devices), null);
  assert.equal(resolveDeviceMention('用 mikafoo 处理', devices), null);
  assert.equal(resolveDeviceMention('用并不存在的设备处理', devices), null);
});

test('设备点名：别名指向多台设备时保守返回 null', () => {
  const devices = [
    ...makeDevices(),
    { id: 'dev_image', name: 'Hermes 图像处理机', platform: 'windows', tags: ['GPU'] },
  ];
  // Hermes 同时是母机标签和图像机名称片段 → 有歧义，不自动派发。
  assert.equal(resolveDeviceMention('用 Hermes 跑', devices), null);
});

test('设备点名：整句只写设备名也识别', () => {
  const devices = makeDevices();
  const mention = resolveDeviceMention('Mika', devices);
  assert.ok(mention);
  assert.equal(mention.deviceId, 'dev_mika');
});
