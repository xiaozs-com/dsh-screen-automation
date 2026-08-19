# 设计文档：为 screen-automation-helper 增加 VLM-grounded 识别与控制（dsh 插件方案）

> 状态：设计稿（未实现代码）
> 范围：本次只产出设计与方案文档。视觉后端选定 **dsh 自带 model adapter**（`ctx.llm`）。
> 配套图示：见 `../` 下的「Skill 与 dsh 插件关系」「VLM 增强闭环」两张图。

---

## 1. 背景与目标

「屏幕自动化小助手」（screen-automation-helper）是一个本地屏幕自动化平台，供人与 Agent（WorkBuddy / Codex / dsh）共用。我们已把它桥接成 DeepSeek Harness 插件 `dsh-screen-automation`（薄桥接：定位二进制 → `cli <子命令>` → 解析 JSON）。

**当前短板（已 grep 真实命令面核实）**：
- **识别栈** = OCR(RapidOCR) + 轮廓/颜色/模板匹配（`screen recognize` / `contours` / `color-regions` / `match`）。**完全没有 VLM / 视觉大模型 / grounding**（全仓搜不到 `vision`/`llm`/`deepseek` 关键字，仅有一个 `chatgpt.exe` 窗口标题匹配）。
- **控制栈** = 鼠标/键盘/窗口，**全部坐标驱动**——OCR 找到文字 → 返回 bbox → 再点那个坐标。`locator find/wait` 是现有里最接近"语义"的东西。

**目标**：让 dsh Agent 能"看懂屏幕并语义化操作"——从「读字」升级到「懂界面」，从「点 (x,y)」升级到「点提交按钮」。并优先复用 **dsh 框架自带的 model adapter**，而非自行接外部模型。

---

## 2. 架构定位：VLM 逻辑放哪一层

原则（已记入项目记忆）：**小助手 CLI 是唯一真相源；Skill 与 dsh 插件都是薄适配器，识别/控制的"智能"只应写在后端，绝不在两边各写一份。**

两条落地路径：

- **路径 A（终态，推荐）**：在小助手侧新增 vision provider（如 `screen understand` 后端命令），VLM grounding 逻辑只写一份；dsh 插件与 Skill 都只暴露它。架构最干净，Skill 侧也能复用。
- **路径 B（本次默认，更快）**：VLM grounding 全部在 dsh 插件内完成——插件用 `ctx.llm` 调 dsh 的视觉模型做截图理解，再用小助手已有的 `mouse click` 执行。优点是不动小助手后端、迭代快；缺点是 Skill 侧暂时复用不到。

**本文档默认按路径 B 设计**（因选定"接 dsh 自带 model adapter"），但在第 7 节给出下沉到路径 A 的迁移里程碑。

---

## 3. 技术地基：dsh 真实可用接口（已对照安装包核实）

以下接口来自本机已安装的 `@deepseek-ai/dsh-llm` 与 `@deepseek-ai/dsh-tools` 类型定义（版本 `dsh-tools@0.0.1-rc.1`、`dsh-llm` 同装）。

### 3.1 模型运行时（核心）
```ts
// @deepseek-ai/dsh-llm —— Context 注入
interface Context {
  llm: LlmRuntime;          // 插件可 inject: ['llm'] 获取
}
class LlmRuntime extends Service {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
interface GenerateOptions {
  provider: string;         // 路由键，如 'deepseek' / 自定义 adapter
  model: string;            // 模型 id
  messages: Message[];      // 多模态消息
  reasoningEffort?: ...;
}
```

### 3.2 多模态内容（截图即 image block）
```ts
// ContentBlock 联合类型
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRef }   // 截图走这里
  | { type: 'tool-call'; ... }
  | { type: 'tool-result'; ... }
  | ...;
// 框架原生支持图像：存在 contentHasImage() 工具函数；user 消息可携带 image。
```
截图不是直接塞 base64，而是先经 **attachment service** 登记字节、拿到 `ImageAttachmentRef`，再包成 `ImageBlock`。具体构造 API 需对照安装版本确认（见第 9 节风险）。

### 3.3 审批闸门（语义操作的安全层）
```ts
// @deepseek-ai/dsh-tools —— ApprovalService
// 通过 ctx.get('approval') 取用，且是 opportunistic（可能不存在 → 自动降级）
const approval = ctx.get('approval');
// ask 仅在审批服务返回 'allowed-once' 时放行；其余三种 deny。
// 部署未组合 ApprovalService 时保持历史降级行为。
```
这对 `click_element` 至关重要：任何"语义控制"都必须先过审批闸门，呼应小助手"先确认再操作"的原则。

### 3.4 既有二进制桥接（沿用）
`dsh-screen-automation` 已有 `runCli(args)`：定位小助手二进制 → `spawn(bin, ['cli', ...args])` → 解析 JSON。新增工具复用它调 `screen capture` / `mouse click` / `screen find`（OCR 回退）。

---

## 4. 新增工具契约（design）

### 4.1 `screen_understand`
```
参数：
  region?   : 屏幕区域（像素 RECT，省略=全屏）
  prompt?   : 给视觉模型的指令（默认"列出界面上可交互元素及坐标"）
执行：
  capture → attachment 登记截图 → ctx.llm.stream({
    provider, model,
    messages:[{role:'user', content:[{type:'text',text:prompt},{type:'image',attachment:ref}]}]
  }) → 解析模型输出
返回：
  { elements: [{ label:string, bbox:[x,y,w,h], confidence?:number }],
    description: string, raw: string }
```

### 4.2 `click_element`
```
参数：
  target   : 语义目标（如 "提交按钮"、"右上角关闭"）
  strategy?: 'vlm' | 'ocr'（默认 vlm；无视觉模型时回退 ocr）
执行：
  capture → grounding(target)  // 调 screen_understand 或 screen find 解析出 bbox
         → 取中心坐标
         → ctx.get('approval')?.ask(...)  // 闸门：allowed-once 才放行
         → runCli(['mouse','click', x, y])
返回：
  { clicked: boolean, bbox, approved: boolean, reason? }
```

### 4.3 `wait_element`
```
参数： target, timeoutSeconds?
执行： 轮询 grounding，直到元素出现或超时
返回： { found: boolean, bbox?, waitedMs }
```

### 4.4 视觉后端可插拔
- **主路径（本方案）**：`ctx.llm` + 已配置的视觉模型（DeepSeek-VL / Qwen-VL 等经 dsh adapter 挂载）。
- **回退**：无 vision 模型时，用 `screen find`（OCR）做文本类 grounding。
- **可选扩展**：OpenAI 兼容视觉端点（仅当 dsh 未提供 adapter 时）。

---

## 5. 安全与权限

1. **语义控制必过审批**：`click_element` / `wait_element` 触发真实输入，强制走 `ctx.get('approval')` 闸门；无审批服务时按 dsh 降级策略处理（默认 deny 更安全）。
2. **截图敏感性**：截图可能含密码/私信。经 attachment service 登记，参考小助手已有的 `recording redact` 做脱敏；插件日志不得打印图像字节，只记录尺寸与元素标签。
3. **解析失败不静默**：grounding 解析不出 bbox → 明确报错，绝不盲点 (0,0) 或随机坐标。
4. **坐标类工具仍不在 dsh 插件暴露裸 `task click/write`**（沿用既有安全边界）。

---

## 6. 架构图对应

- 「Skill 与 dsh 插件关系」图：本方案新增的 VLM 能力**只经 dsh 插件这侧暴露**（路径 B）；终态应下沉到小助手后端，使 Skill 侧也能复用（路径 A）。
- 「VLM 增强闭环」图：`Agent → screen_understand → ctx.llm(视觉模型) → 元素+bbox → click_element(grounding) → 小助手控制层(mouse click)`，虚线为结果回传 Agent 的闭环。

---

## 7. 实施里程碑

- **M1 — `screen_understand`（接 `ctx.llm`）**
  在 `dsh-screen-automation` 内加工具：capture → attachment → `ctx.llm.stream` 多模态调用 → 解析元素。用 **mock `ctx.llm.stream`**（桩回固定元素）做运行时冒烟。
- **M2 — `click_element` + `wait_element`（接审批闸门）**
  加 grounding + `ctx.get('approval')?.ask` 闸门，复用 `runCli(['mouse','click'])`。
- **M3 — OCR 回退路径**
  当无 vision 模型时，grounding 改走 `screen find`（OCR）。
- **M4（终态，路径 A）— 下沉到小助手**
  把 grounding 抽成小助手 `screen understand` 后端命令；dsh 插件与 Skill 都改为只暴露该命令，消除双份逻辑。

---

## 8. 验证策略（复用本次会话已验证的方法）

- **类型层**：`npm i --ignore-scripts @deepseek-ai/cordis @deepseek-ai/dsh-tools @deepseek-ai/dsh-llm typescript @types/node` 后 `tsc --noEmit`，对照真实类型（顺带再抓"文档 vs 真实类型"的偏差）。
- **运行时层**：mock `ctx`（含 `llm.stream` / `get('approval')` / `spawn` 桩二进制）跑 `apply`+`execute` 全链路，验证 grounding→click 组装正确。
- **真机端到端**：需在**已安装小助手** + **已配置视觉模型的 dsh** 上跑；本仓库不携带二进制与模型。

---

## 9. 风险与开放问题

1. **第三方插件可见性**：`ctx.llm` 是否对第三方插件开放（service 可见性/权限）——需实测确认。若不可见，则只能走"路径 A 下沉到小助手"或"可选 OpenAI 兼容端点"。
2. **attachment 构造 API**：`ImageAttachmentRef` 的具体构造（字节如何登记、是否要 `ctx.attachments` 服务）需对照安装版本核对——再次印证"以真实类型为准"。
3. **模型延迟**：VLM 往返延迟影响"看→想→点"闭环的交互体验，必要时加缓存/裁剪区域。
4. **版本漂移**：所有接口名（`ctx.llm` / `GenerateOptions` / `ImageBlock` / `approval` 取用方式）均基于 `dsh-tools@0.0.1-rc.1` 同装版本，升级后须重验。

---

## 10. 结论

把"增强本地识别与控制"做成 dsh 插件最自然的切入点，是新增 **`screen_understand`（VLM 理解）+ `click_element` / `wait_element`（语义 grounding + 审批闸门）** 三个工具，复用 dsh 自带的 `ctx.llm` 多模态能力与 `approval` 闸门，并保留 OCR 回退。终态应将 grounding 下沉到小助手后端（路径 A），让 Skill 与 dsh 插件共用一份"智能"。本方案所有接口地基均已对照真实类型核实，落地时按第 8 节方法验证即可。
