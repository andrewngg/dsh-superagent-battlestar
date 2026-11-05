# Credits · 第三方组件与许可说明

> 项目：**超级管家 / Super Butler**（`super-butler`）
> 许可证：**MIT**（见 [LICENSE](LICENSE)）
> 维护者：Super Butler contributors

本文件记录参考项目、运行时依赖与构建工具的来源和许可证。上传 GitHub 前请保留本文件，
它同时说明「哪些是参考、哪些是运行时依赖、哪些没有复制」，避免许可误解。

## 1. 为什么选择 MIT

本项目以 **MIT** 发布，推荐用于 GitHub 公开仓库：

- 最宽松、最易被复用；与参考项目 `dsh-superagent-prototype`（MIT）和 `DeepSeek Harness`（MIT）一致；
- 允许个人/商业使用、修改、再发布，只需保留版权与许可声明；
- 本项目**没有复制** `dsh-Go`（AGPL-3.0）的代码或素材，因此不必整库采用 AGPL；
- 没有 npm 运行时依赖需要处理（零依赖），许可面很干净。

如果未来希望更强的专利授权或更严格的开源约束，可考虑：

| 许可证 | 适用场景 | 注意 |
| --- | --- | --- |
| **MIT（当前，推荐）** | 个人项目、插件生态、希望被广泛复用 | 无专利明示；需保留声明 |
| **Apache-2.0** | 希望包含明确专利授权、较大型项目 | 需保留 NOTICE；与 MIT 兼容 |
| **AGPL-3.0** | 若未来**复制/修改** `dsh-Go` 或类似 AGPL 代码，且提供网络服务 | 网络使用也需开源；品牌/素材另有约束 |
| **GPL-3.0** | 希望衍生作品必须开源 | 与 MIT 生态兼容性较差 |

> 只要不复制 `dsh-Go` 的代码/素材，本项目的 MIT 许可是成立的。
> 如果你以后想直接复用它的代码，应把相应文件按其 AGPL-3.0 处理，并联系原作者（其 README 有署名与合作请求）。

## 2. 参考项目（设计/交互灵感）

| 项目 | 许可证 | 本项目如何使用 | 是否复制代码/素材 |
| --- | --- | --- | --- |
| [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | **MIT** | 参考「目标—授权—执行—回报」、orchestrator/ticket/assignment 的自主 Agent 设计思路，以及 DSH 插件/面板的组织方式 | 否（仅概念参考，独立实现） |
| [ccch1mneyyy/dsh-Go](https://github.com/ccch1mneyyy/dsh-Go) | **AGPL-3.0**（README 另有作者署名/合作请求；品牌与素材不在开源授权内） | 参考手机端「查看主机 / 切主机 / 掌上控制」的交互方向；本项目 APK 为独立 WebView 实现 | 否（未复制代码、素材、名称或吉祥物） |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | **MIT** | 运行平台与插件 API（Cordis / slots / webServer / credentials） | 否（插件通过宿主 API 运行，未内嵌 DSH 代码） |

## 3. 运行时集成的外部工具（不随仓库分发）

以下工具由用户设备自行安装，本项目只通过 CLI/HTTP 调用，**不包含其源代码或二进制**：

| 工具 | 许可证 | 用途 |
| --- | --- | --- |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | **MIT** | 第一台工作机的通用 CLI 执行器（`hermes --cli -z`），以及其 profiles / gateways / skills 能力申报 |
| [anomalyco/opencode](https://github.com/anomalyco/opencode)（opencode.ai） | **MIT** | 代码任务执行器（`opencode run -m opencode/deepseek-v4-flash-free`） |
| [ollama/ollama](https://github.com/ollama/ollama) | **MIT** | 本地模型运行时（`qwen2.5vl:7b`） |
| [wangzan101/Mika](https://github.com/wangzan101/Mika) | **Apache-2.0** | 手机端 AI Agent：通过 `mika` CLI（USB/ADB 或 Wi-Fi 私有网络）把手机作为工作机接入，**不随仓库分发** |
| [Comfy-Org/ComfyUI](https://github.com/Comfy-Org/ComfyUI) | **GPL-3.0** | 第二台电脑的图像/视频生成服务，仅通过 HTTP API 调用，**不随仓库分发** |
| [React](https://github.com/facebook/react) | **MIT** | DSH Web Client 由宿主提供 React 模块；插件 `require('react')`，不打包 React |
| 豆包 / 火山方舟（ByteDance） | 专有服务/应用 | 目前由用户用桌面版人工操控手机检索 APK；**不随仓库分发**，名称与商标归字节跳动 |
| DeepSeek API、Agnes AI API | 各服务商条款 | 用户自行配置 API Key 后调用；模型与接口不在本仓库内 |

## 4. 构建工具（不随仓库分发）

| 工具 | 许可证 | 用途 |
| --- | --- | --- |
| Eclipse Temurin JDK 17 | GPLv2 + Classpath Exception | 构建 APK（`toolchain/` 已 gitignore，未提交） |
| Android SDK Build-Tools 36 / Platform 36 | Apache-2.0 | `aapt2` / `d8` / `zipalign` / `apksigner`、`android.jar`（未提交） |
| Python + Pillow | PSF / HPND | 生成 APK 图标（构建时使用） |

## 5. 仓库内原创内容

- 所有 Hub / 设备代理 / Web 控制台 / DSH 插件代码：原创，MIT；
- `dist/icon-512.png`、`android/res/mipmap-*`、`dsh-plugin/icon.svg`：本项目原创图标；
- APK 仅使用 Android 系统组件（无 AndroidX、无第三方 SDK）；
- `dist/BattleStar-0.1.0.apk`：本项目构建产物，使用测试签名（`android/keystore/` 本地生成，已 gitignore，不提交）。

## 6. 商标声明

DeepSeek、DeepSeek Harness、DSH 为 DeepSeek 的商标/名称；Hermes Agent 为 Nous Research 的项目；
OpenCode 为 anomalyco 的项目；Ollama 为 Ollama 的项目；豆包为字节跳动的产品。
本项目为独立第三方项目，与上述公司/组织无隶属或背书关系，名称仅用于说明兼容与集成对象。

## 7. AGPL 合规备注（针对 dsh-Go）

`dsh-Go` 以 AGPL-3.0 发布，其 README 另有限制/请求：

- 基于它改造、二次开发或衍生产品发布前，应先联系原作者说明用途；
- 再发布需标注主仓库与作者；
- 其名称、标识、Deepy / 鲸娘等素材不在开源授权内，不能用于套皮/商业分发。

本项目**没有**复制或修改其代码/素材，因此不构成 AGPL 衍生作品；本项目使用自己的名称、
图标与 WebView 实现，并在 README / CREDITS 中明确致谢其交互灵感。若你未来引入其代码，
请把相关代码按 AGPL-3.0 处理，并遵守上述署名与合作请求。

## 8. 上传 GitHub 前检查

- [ ] 不提交 `hub/data/`（含管理员令牌、设备令牌、任务历史）
- [ ] 不提交 `device-agent/.state/`（设备令牌）
- [ ] 不提交 `toolchain/`（JDK/SDK，体积大且许可独立）
- [ ] 不提交 `android/keystore/`（测试签名私钥）
- [ ] 不提交真实 API Key（本项目密钥应放在 DSH credentials / 本机环境变量）
- [ ] 保留 `LICENSE`、`CREDITS.md`、`README.md` 的致谢与许可说明
- [ ] 若发布 APK Release，注明测试签名与只在内网使用的安全边界
