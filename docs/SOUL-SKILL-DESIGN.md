# BattleStar 心智设计：Soul / Skill（§9）

> 目标：给自主大脑一个稳定的人格（Soul）与一套做事方式（Skill），
> 让它每次思考都由 Agnes 模型在「灵魂 + 工作流程 + 六步协议 + 现场快照」的约束下完成。
> 本文件是后端与 Web UI 的唯一契约。

## 9.1 概念

- **Soul（灵魂）**：大脑是谁——价值观、气质、语气、取舍原则、面对不确定/风险/失败的态度、与主人的关系。稳定、少改。
- **Skill（技能/工作方法）**：大脑怎么做事——从观察、判断主要矛盾、评估方案，到小步执行、复盘、请求主人决策的步骤化流程。可迭代。
- 默认内容由五个仓库的知识蒸馏而来（见 `docs/soul.default.md`、`docs/skill.default.md` 与 `docs/SOUL-SKILL-RESEARCH.md`）：
  `andrewngg/mao_junshi`、`andrewngg/dingyuanying-skill`、`andrewngg/szbf`、
  `LiaoFaJun-hub/The-Way-Seeking-Method`、`nuwa-skills/hanfeizi-skill`。
- 模型：沿用自主大脑的 Agnes 配置（`BRAIN_API_KEY` / `BRAIN_BASE_URL` / `BRAIN_MODEL`，
  回退 `AGNES_*`），无需新增模型设置。

## 9.2 数据模型（state.json `mind`）

```json
{
  "mind": {
    "soul": "……（默认或用户自定义，多行文本）",
    "skill": "……（默认或用户自定义，多行文本）",
    "updatedAt": "2026-11-16T08:00:00.000Z"
  }
}
```

- 上限：`MAX_SOUL_CHARS = 6000`，`MAX_SKILL_CHARS = 12000`（超出按上限截断并在 API 校验时报 400）。
- 空文本非法（400 `灵魂不能为空` / `工作流程不能为空`）；恢复默认用 `resetSoul` / `resetSkill`。
- 持久化：`serializeState()` 增加 `mind`；`init()` 用 `restoreMind(savedObj.mind)` 恢复。

## 9.3 模块 `hub/lib/soul-defaults.js`（生成文件）

```js
module.exports = { DEFAULT_SOUL, DEFAULT_SKILL };
```

内容由 `docs/soul.default.md`、`docs/skill.default.md` 生成（脚本 `tmp/generate-soul-defaults.js`），
不要手改；要改默认内容改 docs 后重新生成。

## 9.4 模块 `hub/lib/soul.js`（纯函数）

- `DEFAULT_MIND_SOUL` / `DEFAULT_MIND_SKILL`：来自 soul-defaults。
- `MAX_SOUL_CHARS`、`MAX_SKILL_CHARS`、`MAX_MIND_TEXT`。
- `defaultMind()` → `{ soul: DEFAULT_SOUL, skill: DEFAULT_SKILL, updatedAt: null }`。
- `restoreMind(raw)` → 容错恢复：字符串字段缺失/非法回退默认；截断到上限。
- `normalizeMindPatch(patch, base)` → `{ ok, value | errors }`
  - `soul`、`skill`：字符串；trim；空 → 报错；超长 → 报错。
  - `resetSoul` / `resetSkill`：布尔；true 时 value 置为默认内容（与显式 soul/skill 互斥，显式优先）。
- `mindToJson(mind)` → `{ soul, skill, updatedAt, defaults: { soul, skill }, limits: { soul: MAX_SOUL_CHARS, skill: MAX_SKILL_CHARS }, soulChars, skillChars }`。

## 9.5 Hub 集成（hub/lib/hub.js）

- 构造函数：`this.mind = restoreMind(options.mind)`。
- `init()`：`if (savedObj.mind) this.mind = restoreMind(savedObj.mind);`
- `serializeState()`：`mind: this.mind`（含 updatedAt）。
- `getMind()` → `mindToJson(this.mind)`。
- `updateMind(patch)`：
  - `normalizeMindPatch` 失败 → `badRequest(errors.join('；'))`；
  - 应用值；`updatedAt = nowIso`；
  - `broadcast('mind.updated', { mind: this.getMind(), at }, { record: false })`；
  - `log('info', '心智更新：soul N 字 / skill M 字')`；`schedulePersist()`；返回 `getMind()`。
- 大脑思考：`_runBrainThink()` 调用 `buildBrainPrompt(snapshot, { mind: { soul, skill } })`。

## 9.6 提示词注入（hub/lib/brain.js `buildBrainPrompt`）

签名：`buildBrainPrompt(snapshot, options = {})`，`options.mind` 可空（缺省时用默认灵魂/流程或跳过）。

系统提示顺序（后写的约束优先级更高，但输出结构不变）：

1. 现有自主管家身份说明、严格 JSON 要求、六步说明。
2. `## 你的灵魂（个性与价值观）` + soul 文本（截断到 `MAX_SOUL_CHARS`）。
3. `## 你的工作方法（思考与行动流程）` + skill 文本（截断到 `MAX_SKILL_CHARS`）。
4. 一句衔接：`先按工作方法推进判断，再把它压缩进六步 assessment；输出仍必须是上面的严格 JSON。`
5. 现有动作约束、保守原则、禁止项、等待用户时的处理。

要求：提示词总长度可控，soul/skill 各自先 trim、超长截断；不得破坏既有无 mind 时的输出（API 不变）。

## 9.7 HTTP 路由（hub/lib/http.js）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/mind` | `{ mind, hubTime }`（含 default/limits） |
| PATCH | `/api/mind` | body：`{ soul?, skill?, resetSoul?, resetSkill? }` → `{ mind, hubTime }`；非法 400 |

均需管理员令牌（`x-butler-token`），错误沿用 `toHttpError`。

## 9.8 Web UI（hub/web）

- 新增第 10 个 tab：`mind`，标签「心智」；移动端 tab 同步增加；缓存戳升级到 `v=20261116f`。
- 页面结构：
  - 顶部说明卡：「这段灵魂与工作流程会在大脑每一轮思考时随现场快照一起交给 Agnes 模型」。
  - 两张编辑卡：**灵魂 Soul**、**工作流程 Skill**，各自 textarea（等宽字体、可纵向拉伸）、
    字数统计 `N / 上限`、`使用默认内容` / `已自定义` 徽标、单卡「恢复默认」。
  - 底部操作条：`保存心智`（PATCH）、`全部恢复默认`（PATCH resetSoul+resetSkill）、
    未保存变更提示（离开 tab 或刷新前提示），保存成功 toast「心智已更新」。
  - 折叠预览：展示「本次思考将使用的完整提示片段」前 600 字。
- 数据：`GET /api/mind` 初始化；`state.mind` / `mindDirty` / `mindBusy` / `mindError`；
  SSE `mind.updated`：非脏状态直接刷新，脏状态只显示「服务端内容已更新」提示，不覆盖编辑。
- i18n：`mind.*` 键（zh/en）。
- 恢复默认按钮调用 `PATCH /api/mind { resetSoul: true }`（或同时）。

## 9.9 测试

- `hub/test/soul.test.js`：默认值非空、长度上限、`normalizeMindPatch`（正常/空/超长/reset/显式优先）、
  `restoreMind` 容错、`mindToJson` 字段与截断。
- `hub/test/mind-hub.test.js`：默认心智存在；PATCH 更新并持久化（重启恢复）；reset 恢复默认；
  `buildBrainPrompt` 注入 soul/skill 且包含六步；SSE `mind.updated` 不写入常规 events；
  HTTP GET/PATCH、非法 400、鉴权；大脑思考时收到注入后的 prompt（注入 brainThink 断言）。
- `docs/ARCHITECTURE.md`：新增「心智（Soul/Skill）」小节；README 更新功能与测试计数。
- 回归：hub 全量、device-agent、shared 全绿。

## 9.10 文件归属

- Lead：`hub/lib/soul.js`、`hub/lib/soul-defaults.js`、`hub/lib/hub.js`、`hub/lib/brain.js`、`hub/lib/http.js`、
  `docs/SOUL-SKILL-DESIGN.md`、`docs/soul.default.md`、`docs/skill.default.md`。
- web-ui：`hub/web/*`（心智页面）。
- verifier：`hub/test/soul*.test.js`、`hub/test/mind*.test.js`、`docs/ARCHITECTURE.md`、`README.md`。
