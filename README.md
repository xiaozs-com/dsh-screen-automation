# dsh-screen-automation

把本地「屏幕自动化小助手」(Screen Automation Helper) 桌面端桥接成 **DeepSeek Harness (dsh)** 的 Agent 工具插件。
让 dsh 里的 Agent 能直接确认平台状态、截图与本地识别、驱动本机鼠标键盘、管理自动化流程——
而真正的本地屏幕观察与执行，仍由你自己的小助手完成。

> 这不是重写屏幕自动化，而是**桥接**：dsh 负责 Agent 编排，小助手负责本地执行。

> ⚠️ **前置依赖**：本插件只是一层桥接，**本机必须先独立安装「屏幕自动化小助手」桌面端**（Windows `.exe` / macOS `.app`），30 个工具才能真正工作。安装方式见下方「[前置依赖：安装屏幕自动化小助手](#前置依赖安装屏幕自动化小助手)」。

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

## 工作流开发语义

本插件不自行解析、转换或补全 `workflow.md`，因此桌面端新增流程语言时，桥接层保持原样透传。
需要创建或修改流程的 Agent 必须遵循“屏幕自动化工程师”的[当前工作流开发标准](https://github.com/xiaozs-com/screen-automation-engineer/blob/main/references/workflow-standard.md)，并以本机
`screen_automation_capabilities` 和 `screen_automation_workflow_inspect` 的结果为准。安装前先检查、
校验流程；校验报错时不得猜测字段或用旧语法绕过。当前标准已包括表单填写的运行期 OCR `锚定`、
相对 `偏移`、`相对【文字】右侧` 等位置约束、越界滚动重定位、锚点虚线提示及安全停止规则。

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
| `screen_automation_workflow_validate` | `cli workflow validate <id>` | 校验已安装 workflow；修改后必须执行，报错时不得猜语法 |
| `screen_automation_workflow_install` | `cli workflow install <source>` | 从本地源（目录/压缩包）安装已按当前流程语言检查过的 workflow |
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

## Agent Bridge 任务级工具策略

插件正常安装在交互式 DSH 会话中时，仍提供完整工具集。由“屏幕自动化小助手”的 Agent Bridge
启动受控任务时，Bridge 会同时设置策略版本和精确工具白名单；插件在每次执行工具前强制校验，
未列入的流程安装、卸载、启动等工具即使出现在模型上下文中也会被拒绝。

策略使用 `SCREEN_AUTOMATION_AGENT_TOOL_POLICY_VERSION=1` 和
`SCREEN_AUTOMATION_AGENT_ALLOWED_TOOLS`。这两个变量是 Bridge 与插件之间的内部契约，普通用户
不应手工设置；只设置其中一个、使用未知策略版本或传入空白名单时，默认拒绝所有插件工具。
此检查是执行边界，不以提示词服从作为授权依据。

## 二进制发现（按优先级）

1. 环境变量 `SCREEN_AUTOMATION_BIN`（最高优先级，直接指向可执行文件）
2. macOS：`SCREEN_AUTOMATION_MAC_APP` → 其下 `Contents/MacOS/screen-automation-helper`
   或 `/Applications/Screen Automation Helper.app/...`、 `$HOME/Applications/Screen Automation Helper.app/...`
3. Windows：`SCREEN_AUTOMATION_WIN_EXE` → `%ProgramFiles%\Xiaozs\ScreenAutomationHelper\...`

都找不到时，工具会抛出带官网下载链接的明确错误。

## 前置依赖：安装屏幕自动化小助手

本插件**不内置**任何屏幕识别或输入执行的代码，它只是一层桥接。要让上面 30 个工具真正可用，
你本机必须先装好「屏幕自动化小助手」(Screen Automation Helper) 桌面端——Windows 上是
`ScreenAutomationHelper.exe`，macOS 上是 `Screen Automation Helper.app`。小助手通过 `cli <subcommand>`
暴露 JSON 接口，本插件只是去「定位二进制 → 调 CLI → 解析 JSON → 回传」。

### 1. 下载与安装

- **Windows 版**：<https://www.xiaozs.com/sah/downloads/windows/latest>
- **macOS 版**：<https://www.xiaozs.com/sah/downloads/mac/latest>
- **ZIP 备用**：<https://www.xiaozs.com/sah/downloads/zip/latest>

按**默认路径**安装即可，插件会自动在系统常见位置发现它（详见下方「二进制发现」一节）。
若使用自定义安装路径，或想在隔离环境里跑，用「二进制发现」里的环境变量 `SCREEN_AUTOMATION_BIN`
等显式指向可执行文件即可，无需放回默认位置。

> 下载页地址以官网为准；如链接变动，请替换为最新官方地址。

### Agent 会在对话里主动提示安装

本插件不靠 README 让 Agent「知道」前置依赖——dsh 在对话中不会读取仓库文档。
真正起作用的是运行时注入给 Agent 的信息：`screen_automation_status` 的工具描述要求 Agent
**先自检**；当小助手未安装时，该工具返回结构化结果（含 `installHint` 与 Windows/macOS/ZIP 下载链接），
其余工具在 `binary not found` 时报错里也带有同样的安装指引。因此 Agent 会在首次调用时自然地把
「请先安装屏幕自动化小助手」及下载链接转述给用户，而不是静默失败。

### 2. 装好后验证

在 dsh 中注册本插件，然后让 Agent 调用一次自检：

```
screen_automation_status
```

- 返回平台可用状态与版本号 → 桥接成功。
- 报 `binary not found` → 安装路径未被自动发现，按「二进制发现」设置 `SCREEN_AUTOMATION_BIN` /
  `SCREEN_AUTOMATION_MAC_APP` / `SCREEN_AUTOMATION_WIN_EXE` 之一后再试。

### 3. 它与 dsh 插件的关系

```
屏幕自动化小助手（本地桌面端，必须独立安装）
        ▲ 被本插件 spawn CLI 调用
        │
dsh-screen-automation（dsh 插件，本仓库）
        ▲ 被 dsh Agent 以工具形式调用
        │
dsh Agent
```

先装小助手，再装本插件，二者各司其职：小助手是 Agent 在本地延伸的「手和眼」，本插件是它们之间的桥。

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

# 3) 通过 dsh 一键安装（需先 `npm publish`，见下「发布到 npm」）
dsh plugin --profile web add dsh-screen-automation && dsh restart web
#    安装后 package.json 的 dsh.bundle.patch (./cordis.patch.yml) 自动把插件行插入 web profile，
#    加载编译产物 ./lib/index.js，30 个工具即注册完毕。
```

> 两个挂载文件分工：
> - `cordis.yml`：`path` 指向 `./src/index.ts`，仅**开发期**热加载（`pnpm dsh web --patch ./cordis.yml`）。
> - `cordis.patch.yml`：发布的 bundle patch，`dsh plugin add` 安装时自动插入插件行，加载编译产物 `./lib/index.js`。
> cordis patch 的具体字段名可能随 dsh 版本变化，若加载报错请对照 `pnpm dsh --help` / 官方 cordis 配置文档调整。

## 发布到 npm（让 `dsh plugin add` 可用）

仓库已加 GitHub `dsh-plugin` 话题（官方发现聚合渠道，搜该话题即可找到）。要让人能
`dsh plugin --profile web add dsh-screen-automation` 一键安装，需要发布到 npm。

### 一次性配置

在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中创建 Secret：

- 名称：`NPM_TOKEN`
- 值：npm 网站创建的 Automation token（只用于发布 `dsh-screen-automation`）

### 日常发布（无需建 GitHub Release）

1. 修改 `package.json` 的 `version`，例如 `0.1.4`，并提交、推送到 `main`。
2. 创建同名标签并推送：`git tag v0.1.4`，然后 `git push origin v0.1.4`。
3. GitHub Actions 的 **Publish to npm** 会自动安装依赖、构建、校验发布内容，然后发布到 npm。

标签必须与 `package.json` 的版本完全相同；不一致时工作流会停止，避免误发布。仅修改文档时不需要改版本、打标签或发布 npm。

发布前确认：`peerDependencies` 已声明 harness 包（与宿主 dsh 共用同一份实例，避免拉第二份 cordis 副本）；
`dsh.bundle.patch` 指向 `cordis.patch.yml`（install 时自动插入插件行）。

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
