# dsh-screen-automation

把本地「屏幕自动化小助手」(Screen Automation Helper) 桌面端桥接成 **DeepSeek Harness (dsh)** 的 Agent 工具插件。
让 dsh 里的 Agent 能直接确认平台状态、截图与本地识别、驱动本机鼠标键盘、管理自动化流程——
而真正的本地屏幕观察与执行，仍由你自己的小助手完成。

> 这不是重写屏幕自动化，而是**桥接**：dsh 负责 Agent 编排，小助手负责本地执行。

## 设计原则

- **桥接而非重实现**：dsh 插件只做「定位二进制 → 调 CLI → 解析 JSON → 回传」，智能只写在后端。
- **全能力桥接**：不人为限制 Agent。workflow 全生命周期、本机输入控制、各类识别原语、
  以及把截图喂给 dsh 视觉模型的 `screen_automation_understand` 全部暴露。小助手就是 Agent 在本地延伸的手和眼。
- **识别阶梯（廉价本地优先）**：OCR / 模板匹配 / 颜色区域 / 轮廓这些**免费本地方法作为一等公民**，能解决就不升到 VLM，省 API 费用。VLM 是按需升层，不是默认路径。
- **本地算力**：所谓「本地」包含本地算力。想免费推理时，把本机视觉模型（Ollama / llama.cpp + Qwen-VL / DeepSeek-VL）注册成 dsh 的一个 provider，再传给 `understand` 即可。

## 架构

```
dsh Agent
   │  工具调用 (screen_automation_*)
   ▼
dsh-screen-automation  (Host 插件, Node/TS)
   │  spawn 二进制 + `cli <subcommand>`（JSON 接口）
   ▼
屏幕自动化小助手  (.exe on Windows / .app on macOS)
   │  本地屏幕识别、鼠标键盘、workflow 运行、结果保存
   ▼
结构化 JSON 结果  ──回传──▶  Agent
```

平台 CLI 与 Windows/macOS 共用同一套命令，且标准输出为 JSON，因此桥接层只需要：
**定位二进制 → 调 CLI → 解析 JSON → 回传**。

## 暴露的工具（共 30 个）

### 1. 平台自检与流程生命周期

| 工具 | 映射的 CLI | 说明 |
|---|---|---|
| `screen_automation_status` | `cli status` | 平台是否可用、版本等自检 |
| `screen_automation_capabilities` | `cli capabilities` | 平台能力清单 |
| `screen_automation_list_workflows` | `cli workflow list` | 已安装流程 |
| `screen_automation_run_workflow` | `cli start-workflow <id>` | 运行流程（支持 `count` / `dry_run`） |
| `screen_automation_stop_run` | `cli stop --run-id <id>` | 停止某次运行 |
| `screen_automation_list_runs` | `cli runs list` | 当前运行实例 |
| `screen_automation_health` | `cli health --workflow <id>` | 运行前健康检查 |
| `screen_automation_capture` | `cli screen capture` | 截图（可选 `region` / `output`） |

### 2. 本地识别原语（免费、本地，省 VLM 费用）

| 工具 | 映射的 CLI | 说明 |
|---|---|---|
| `screen_automation_recognize_text` | `cli screen recognize` | OCR 全文识别，返回文字与区域框 |
| `screen_automation_locate_text` | `cli screen find --text <t>` | 按文字定位，返回坐标（"点提交按钮"类任务优先用） |
| `screen_automation_color_regions` | `cli screen color-regions` | HSV 颜色区域检测（"按钮变绿再点"类检查） |
| `screen_automation_match_template` | `cli screen match --template <p>` | 模板匹配（按图找图标/Logo） |
| `screen_automation_contours` | `cli screen contours` | 轮廓/形状检测（按形状/尺寸定位元素） |
| `screen_automation_wait_text` | `cli screen wait --text <t>` | 轮询等待文字出现（廉价的状态等待原语） |

### 3. 本机输入控制

| 工具 | 映射的 CLI | 说明 |
|---|---|---|
| `screen_automation_click` | `cli click` | 鼠标点击（点格式 `"x,y"`，可选 `button`） |
| `screen_automation_drag` | `cli drag` | 拖拽（`start`→`end`，可选 `duration` / `button`） |
| `screen_automation_scroll` | `cli scroll` | 在指定点滚动（`amount` 正下负上） |
| `screen_automation_long_press` | `cli long-press` | 长按（可选 `duration` / `button`） |
| `screen_automation_type_text` | `cli type` | 向焦点元素输入文字（可选 `interval`） |
| `screen_automation_hotkey` | `cli hotkey` | 组合键，如 `"ctrl c"` / `"win v"` |

### 4. 工作流全生命周期（安装 / 校验 / 移除）

| 工具 | 映射的 CLI | 说明 |
|---|---|---|
| `screen_automation_workflow_validate` | `cli workflow validate <id>` | 校验已安装 workflow |
| `screen_automation_workflow_install` | `cli workflow install <source>` | 从本地源（目录/压缩包）安装 workflow |
| `screen_automation_workflow_remove` | `cli workflow remove <id>` | 移除已安装 workflow |

### 5. 任务会话（绑定窗口，后续控制/识别在该窗口内生效）

| 工具 | 映射的 CLI | 说明 |
|---|---|---|
| `screen_automation_task_begin` | `cli task begin` | 开始任务会话，可按 `title` / `process` / `handle` 绑定窗口 |
| `screen_automation_task_status` | `cli task status` | 报告当前任务会话目标窗口 |
| `screen_automation_task_end` | `cli task end` | 结束当前任务会话 |

### 6. 工作流只读信息

| 工具 | 映射的 CLI | 说明 |
|---|---|---|
| `screen_automation_workflow_show` | `cli workflow show <id>` | 查看已安装 workflow 的配置/清单 |
| `screen_automation_workflow_describe` | `cli workflow describe <id>` | 获取 workflow 的可读说明/元数据 |
| `screen_automation_workflow_inspect` | `cli workflow inspect <source>` | 检查未安装的 workflow 源（返回清单） |

### 7. 视觉理解（识别阶梯最高层：VLM）

`screen_automation_understand` 把小助手截图喂给 dsh 的视觉模型：

```
screen capture 拿图 → ctx.attachments.saveImage 登记为不可变图片引用
  → 拼 [文字提问 + image block] 的 user 消息 → ctx.llm.stream 多模态推理 → 收集 text-delta
```

- 这是「按需升层」：OCR/模板/颜色能解决就别调它，省 API 钱；**开放任务**（"这屏在干嘛、哪出错了"）才升到 VLM。
- 模型走 dsh 当前 profile 配置的 `provider` / `model`。**想免费本地推理**：把本机视觉模型（Ollama / llama.cpp + Qwen-VL / DeepSeek-VL）
  注册成 dsh 的一个 provider，再把 `provider` / `model` 传进工具即可——本地算力，不烧远程 VLM。
- 依赖 dsh 运行时的 `ctx.llm`（视觉模型服务）与 `ctx.attachments`（图片登记服务）；任一不可用，工具会抛出明确错误。

## 二进制发现（按优先级）

1. 环境变量 `SCREEN_AUTOMATION_BIN`（最高优先级，直接指向可执行文件）
2. macOS：`SCREEN_AUTOMATION_MAC_APP` → 其下 `Contents/MacOS/screen-automation-helper`
   或 `/Applications/Screen Automation Helper.app/...`、 `$HOME/Applications/Screen Automation Helper.app/...`
3. Windows：`SCREEN_AUTOMATION_WIN_EXE` → `%ProgramFiles%\Xiaozs\ScreenAutomationHelper\...`

都找不到时，工具会抛出带官网下载链接的明确错误。

## 安装与构建

```sh
# 1) 安装依赖并编译（产出 lib/，即插件运行入口）
cd dsh-screen-automation
npm install
npm run build          # 需要 typescript（已列入 devDependencies）

# 2) 开发调试（最快看到效果，直接挂载 TypeScript 源）
#    在 deepseek-harness 仓库内：
pnpm dsh web --patch ./cordis.yml
#    控制台出现 [screen-automation] loaded 即成功（cordis.yml 指向 ./src/index.ts）

# 3) 正式发布后：
dsh plugin --profile web add dsh-screen-automation && dsh restart web
#    正式加载的是 package.json 中 dsh.host 指向的编译产物 ./lib/index.js
```

> `cordis.yml` 的 `path` 字段指向 `./src/index.ts`（开发期热加载）；
> 正式发布由 `package.json` 的 `dsh.host: ./lib/index.js` 决定加载编译产物。
> cordis patch 的具体字段名可能随 dsh 版本变化，若加载报错请对照 `pnpm dsh --help` / 官方 cordis 配置文档调整。

## 扩展

- 想加更多能力：在小助手的 `runtime/cli.py` 已有的子命令里挑，照 `cliTool({...})` 模式加一个工具即可。
- 想接 IPC（比 CLI 更实时）：把 `runCli` 换成对小助手 `~/Library/Application Support/Screen Automation Helper/ipc/`
  端点（endpoint.json + token）的调用，工具签名不变。
- 想暴露「运行后读取结果文件」：在 `screen_automation_run_workflow` 的 `output` 之后，加一个读 `runs/<run_id>` 结果目录的工具。

## 验证状态

- **依赖完整性**：原 `package.json` 缺 `typescript`，已补入 `devDependencies`；`npm install && npm run build` 现在可稳定产出 `lib/index.js` + `lib/index.d.ts`。
- **类型层**：对照真实发布的 `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-attachment` 编译通过。
- **运行时层**：用桩二进制（写一张 PNG 到 `--output`）+ mock `ctx.llm.stream` / `ctx.attachments.saveImage` 验证全链路——
  30 个工具注册成功，`screen_automation_understand` 正确执行 `cli screen capture --output`、读字节、登记 attachment、
  把 image block 塞进 `llm.stream` 的消息、并累积 text-delta 成结果。
- 真机端到端需在已安装小助手 `.app`/`.exe` 且 dsh profile 配置了视觉模型的机器上跑（本仓库不携带该二进制）。

## License

MIT
