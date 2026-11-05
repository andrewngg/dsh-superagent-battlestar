# 第二台电脑：ComfyUI 工作机

第二台电脑作为独立设备接入管家，申报 **ComfyUI 图像/视频生成**能力；管家按技能把生成任务路由过去，
由设备代理调用本机 ComfyUI 的 HTTP API 执行，并把结果图片下载到本机。

```
Hub（第一台电脑 / NAS）
  └── 设备代理（第二台电脑）
        └── ComfyUI HTTP API（127.0.0.1:8188）
              └── 工作流 JSON → 生成图片 → 下载到 outputDir
```

## 1. 准备

第二台电脑需要：

- Node.js ≥ 18（只跑设备代理，不需要装 Hub）；
- 可用的 ComfyUI（默认 `http://127.0.0.1:8188`）；
- 一个 **API 格式** 的工作流 JSON：ComfyUI 打开工作流 → 设置里开启开发者模式 → 「Save (API Format)」导出；
- 工作流中的节点 ID：正面提示词节点（CLIPTextEncode）、负面提示词节点（可选）、KSampler seed 节点（可选）。

复制项目里的 `device-agent/` 与 `shared/` 到第二台电脑（或复制整个 `super-butler/`）。

## 2. 配置

复制 `device-agent/configs/comfyui-machine.example.json` 为 `device-agent/configs/comfyui-machine.json`，按实际修改：

```jsonc
{
  "name": "第二台电脑 · ComfyUI",
  "platform": "windows",
  "executor": {
    "type": "comfyui",
    "comfyui": {
      "baseUrl": "http://127.0.0.1:8188",
      "workflowFile": "C:/Users/you/ComfyUI/workflows/text2img_api.json",
      "promptNodeId": "6",          // 正面提示词节点 ID（API JSON 的键）
      "negativeNodeId": "7",        // 可选
      "negativePrompt": "blurry, low quality, watermark",
      "seedNodeId": "3",            // 可选；每次随机 seed
      "outputDir": "C:/Users/you/super-butler-worker/comfyui-out",
      "timeoutMs": 900000,
      "pollMs": 1500,
      "maxImages": 8
    }
  }
}
```

说明：

- `workflowFile` 是 ComfyUI API 格式（不是 UI 格式），节点为 `{ "6": { "class_type": "...", "inputs": {...} } }`；
- 执行器会克隆工作流，把任务指令写入 `promptNodeId` 节点的 `inputs.text`，可选的负面提示词与随机 seed 也会写入；
- `baseUrl` 只允许本机或内网地址（执行器会校验，禁止指向 Hub 自身）；
- 生成图片保存到 `outputDir`，任务结果中会列出文件名与本地路径；
- 如果工作流使用中文提示词、参考图、LoRA 等，请在导出前固定好，或把 `promptNodeId` 指向正确的文本节点。

## 3. 接入管家

在第二台电脑启动设备代理（Hub 地址用第一台电脑的内网 IP）：

```powershell
node device-agent\agent.js `
  --hub http://192.168.1.10:7317 `
  --join-code <Hub 启动日志里的加入码> `
  --config device-agent\configs\comfyui-machine.json `
  --state-dir device-agent\.state\comfyui
```

成功后在控制台/手机端应看到：

- 设备名「第二台电脑 · ComfyUI」，在线；
- skills：`image-generation`、`image-edit`、`upscale`、`video-generation`、`comfyui-workflow`；
- gateway：`comfyui`。

## 4. 发任务

在控制台/手机端或 API 中创建任务，requirements 指定技能：

```powershell
curl.exe -X POST http://127.0.0.1:7317/api/tasks `
  -H "X-Butler-Token: <管理员令牌>" -H "Content-Type: application/json" `
  -d '{"instruction":"生成一张赛博朋克风格的家庭客厅，暖色灯光，16:9","requirements":{"skills":["image-generation"]},"timeoutSec":900}'
```

任务完成后的 `output.text` 会包含 ComfyUI `prompt_id`、工作流路径和每张图片的本地路径；
`output.artifacts` 同时包含结构化条目 `{ name, path, type: "image" }`。

> 当前 Hub 不把设备本地图片上传到 Web 控制台（设备文件留在第二台电脑）。需要预览时在第二台电脑打开
> `outputDir` 里的文件；后续可以加「设备产物回传」功能。

## 5. 故障排查

| 现象 | 处理 |
| --- | --- |
| 任务失败：缺少 workflowFile | 配置路径填错或未导出 API 格式工作流 |
| 未找到文本编码节点 | 设置 `promptNodeId` 为 API JSON 中 CLIPTextEncode 的键 |
| `/prompt` 返回 400 / node_errors | 工作流节点参数不完整、模型文件缺失，或 ComfyUI 版本不兼容 |
| 生成超时 | 调大 `timeoutMs`；确认 ComfyUI 队列没有卡住 |
| 下载图片失败 | 确认 `baseUrl` 可访问，且 `/view` 返回图片 |
| 设备离线 | 检查代理进程、Hub IP、防火墙和加入码 |

## 6. 安全与许可

- ComfyUI 只监听本机；不要把 8188 暴露到公网；
- 生成的图片与模型权重留在第二台电脑，模型/工作流许可由你自行确认；
- ComfyUI 本身为 GPL-3.0 外部依赖，本项目不包含其代码或权重（见 [CREDITS.md](../CREDITS.md)）。
