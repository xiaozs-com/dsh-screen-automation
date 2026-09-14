import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// 把截图喂给 dsh 的视觉模型所需类型与工厂：
// - MessageId 构造带 brand 的消息 id；Message/ContentBlock/ImageBlock 是多模态消息的结构
// - ImageAttachmentRef/SaveImageAttachment/ImageMediaType 是 attachment 服务的写入契约
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { Message, ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, SaveImageAttachment, ImageMediaType } from '@deepseek-ai/dsh-attachment'

// 插件身份：name 是插件在配置树里的稳定 id；inject 声明本插件依赖的
// Harness 服务。除了工具注册表 tools，understand(VLM 视觉理解) 工具还需要
// llm（视觉推理）与 attachments（把截图登记为图片引用）两个服务。不把它们
// 列入 inject，Cordis 会在执行里访问 ctx.llm / ctx.attachments 时抛
// "cannot get property 'llm' without inject"。注意：被注入的服务必须在该
// profile 中存在，否则整个插件不会激活（见末尾说明）。
export const name = 'screen-automation'
export const inject = ['tools', 'llm', 'attachments']

/**
 * 这个插件把本地「屏幕自动化小助手」(Screen Automation Helper) 桌面端桥接进
 * DeepSeek Harness 的 Agent 工具系统。
 *
 * 架构（桥接而非重实现）：
 *   dsh Agent  ──工具调用──▶  本插件(Host, Node/TS)  ──spawn CLI(JSON)──▶  屏幕自动化小助手(.exe/.app)
 *   负责编排/规划          负责把能力暴露成工具             负责本地屏幕观察与执行
 *
 * 小助手通过 `cli <subcommand>` 暴露 JSON 接口（与 Windows/macOS 同一套命令），
 * 本插件只做三件事：定位二进制、调用 CLI、把 JSON 结果回传给 Agent。
 *
 * 设计原则（全能力桥接 + 识别阶梯）：
 *  - 不人为限制 Agent 能力：workflow 全生命周期、本机输入控制、各类识别原语都暴露。
 *  - 廉价本地识别优先：OCR / 模板匹配 / 颜色区域 / 轮廓 这些免费本地方法作为一等公民，
 *    能解决就不升到 VLM，省 API 调用（钱）。VLM 是按需升层，非默认路径。
 *  - "本地"含本地算力，故 VLM 应下沉到小助手后端用本机推理，而非默认远程端点。
 */

/**
 * 小助手未安装时给 Agent / 用户看的统一安装指引。
 * 注意：dsh 不会去读 README，Agent 只在工具描述与工具返回/报错里获得信息，
 * 所以这段引导必须写进运行时可被 Agent 读到的地方（下方两个 not-found 报错 + status 工具描述）。
 * 链接按平台细分（Windows / macOS / ZIP 备用），与官方下载页一致。
 */
const INSTALL_HINT =
  'The local "Screen Automation Helper" desktop app is required but was not found. ' +
  'Install it (free, Windows / macOS) from one of:\n' +
  '  Windows: https://www.xiaozs.com/sah/downloads/windows/latest\n' +
  '  macOS:   https://www.xiaozs.com/sah/downloads/mac/latest\n' +
  '  ZIP:     https://www.xiaozs.com/sah/downloads/zip/latest\n' +
  'Or point this plugin at an existing install via one of the env vars: ' +
  'SCREEN_AUTOMATION_BIN, SCREEN_AUTOMATION_MAC_APP, SCREEN_AUTOMATION_WIN_EXE.'

const BRIDGE_POLICY_VERSION = '1'

/** Bridge tasks receive an exact allowlist; normal DSH sessions keep all tools. */
export function isToolAllowedByBridge(
  toolName: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const policyVersion = env.SCREEN_AUTOMATION_AGENT_TOOL_POLICY_VERSION?.trim()
  const rawAllowlist = env.SCREEN_AUTOMATION_AGENT_ALLOWED_TOOLS
  if (!policyVersion && rawAllowlist === undefined) return true
  if (policyVersion !== BRIDGE_POLICY_VERSION || rawAllowlist === undefined) return false
  const allowed = new Set(rawAllowlist.split(',').map((item) => item.trim()).filter(Boolean))
  return allowed.has(toolName)
}

/** 在多个候选路径里找到已安装的屏幕自动化小助手二进制。优先级：环境变量 > 平台默认位置。 */
function resolveBinary(): string | null {
  const env = process.env
  if (env.SCREEN_AUTOMATION_BIN && fs.existsSync(env.SCREEN_AUTOMATION_BIN)) {
    return env.SCREEN_AUTOMATION_BIN
  }
  if (process.platform === 'darwin') {
    const macApp = env.SCREEN_AUTOMATION_MAC_APP
    const candidates = [
      macApp ? `${macApp}/Contents/MacOS/screen-automation-helper` : null,
      '/Applications/Screen Automation Helper.app/Contents/MacOS/screen-automation-helper',
      `${env.HOME}/Applications/Screen Automation Helper.app/Contents/MacOS/screen-automation-helper`,
    ].filter(Boolean) as string[]
    for (const c of candidates) if (fs.existsSync(c)) return c
    return null
  }
  if (process.platform === 'win32') {
    const win = env.SCREEN_AUTOMATION_WIN_EXE
    if (win && fs.existsSync(win)) return win
    const candidates = [
      env.LOCALAPPDATA
        ? `${env.LOCALAPPDATA}\\Programs\\Xiaozs\\ScreenAutomationHelper\\ScreenAutomationHelper.exe`
        : null,
      env.ProgramFiles
        ? `${env.ProgramFiles}\\Xiaozs\\ScreenAutomationHelper\\ScreenAutomationHelper.exe`
        : null,
      env['ProgramFiles(x86)']
        ? `${env['ProgramFiles(x86)']}\\Xiaozs\\ScreenAutomationHelper\\ScreenAutomationHelper.exe`
        : null,
    ].filter(Boolean) as string[]
    for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
    return null
  }
  return null
}

/** 调用小助手 CLI（统一前缀 `cli`），解析 JSON 标准输出，返回结构化结果。 */
async function runCli(
  args: string[],
  timeoutMs = 30000,
  stdinText?: string,
): Promise<{ ok: boolean; command: string; raw: string; data: any }> {
  const bin = resolveBinary()
  if (!bin) {
    throw new Error(INSTALL_HINT)
  }
  const command = `cli ${args.join(' ')}`
  return new Promise((resolve, reject) => {
    const child = execFile(bin, ['cli', ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = (stdout || '').toString()
      let data: any = null
      try {
        data = JSON.parse(raw)
      } catch {
        data = null
      }
      if (err) {
        const msg = err instanceof Error ? err.message : String(err)
        reject(new Error(
          `screen_automation CLI failed (${command}): ${msg}\n--- stdout ---\n${raw}\n--- stderr ---\n${stderr || ''}`,
        ))
        return
      }
      resolve({ ok: true, command, raw, data })
    })
    if (stdinText !== undefined) child.stdin?.end(stdinText)
  })
}

// 参数 schema 直接交给 defineTool 校验；这里用宽松类型避免与官方 ParameterSchemaSpec 字面量约束冲突。
type CliToolOptions = {
  name: string
  description: string
  parameters: any
  buildArgs: (args: any) => string[]
  stdinText?: (args: any) => string
  // 二进制缺失等可预期错误时，不抛错、而是返回结构化结果（含 installHint），便于 Agent 直接转述安装引导。
  softFail?: boolean
}

/** 把一个 CLI 子命令包装成一个 dsh 工具：注册 → 调用 CLI → 透传 JSON 结果。 */
function cliTool(opts: CliToolOptions) {
  return defineTool({
    name: opts.name,
    description: opts.description,
    parameters: opts.parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          command: { type: 'string', required: true },
          raw: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const v = value as { raw?: string; data?: unknown }
        const body = typeof v.raw === 'string' && v.raw.trim().length > 0 ? v.raw : JSON.stringify(v.data ?? null, null, 2)
        return [{ type: 'text', text: `${opts.name}\n${body}` }]
      },
    },
    async execute(args) {
      if (!isToolAllowedByBridge(opts.name)) {
        throw new Error(`screen_automation tool denied by Agent Bridge task policy: ${opts.name}`)
      }
      try {
        return await runCli(opts.buildArgs(args), 30000, opts.stdinText?.(args))
      } catch (e) {
        if (opts.softFail) {
          const msg = e instanceof Error ? e.message : String(e)
          return { ok: false, command: opts.name, raw: msg, data: { installed: false, installHint: INSTALL_HINT } }
        }
        throw e
      }
    },
  })
}

export function apply(ctx: Context): void {
  // 1) 平台自检
  ctx.tools.register(cliTool({
    name: 'screen_automation_status',
    description:
      'Check whether the local Screen Automation Helper desktop platform is available and report its status as JSON. ' +
      'ALWAYS call this first to confirm the bridge works before any other screen_automation_* tool. ' +
      'If it reports the helper is not installed (installed:false / "binary not found"), STOP and tell the user how ' +
      'to install it — share the Windows/macOS/ZIP download links from the result error — and do NOT attempt other ' +
      'screen_automation_* tools until the helper is installed and this status call succeeds.',
    parameters: {},
    softFail: true,
    buildArgs: () => ['status'],
  }))

  // 2) 能力清单
  ctx.tools.register(cliTool({
    name: 'screen_automation_capabilities',
    description: 'List the capabilities the local Screen Automation Helper platform exposes (CLI / IPC features).',
    parameters: {},
    buildArgs: () => ['capabilities'],
  }))

  // 浏览器增强使用小助手的跨进程受管会话。工具层不暴露 --new 或 --stop-daemon，
  // 避免 Agent 在每轮观察时关闭并重建浏览器。
  ctx.tools.register(cliTool({
    name: 'screen_automation_browser_health',
    description: 'Check browser-enhancement availability. Call before opening a managed browser when status has not been checked.',
    parameters: {},
    buildArgs: () => ['browser', 'health'],
  }))

  ctx.tools.register(cliTool({
    name: 'screen_automation_browser_status',
    description: 'Report browser-enhancement installation, daemon and active managed sessions. On browser_session_not_open, call this once and report the state; never loop browser_open.',
    parameters: {},
    buildArgs: () => ['browser', 'status'],
  }))

  ctx.tools.register(cliTool({
    name: 'screen_automation_browser_open',
    description: 'Open or reuse one persistent managed Chrome/Edge session and optionally enter a URL immediately. Call once at the start of a browser task. On waiting_for_user, use credentials only when the user explicitly supplied them; otherwise stop and ask the user to log in in the open window. Never refresh, close or reopen while waiting.',
    parameters: {
      browser: { type: 'string', required: true, enum: ['chrome', 'edge'], description: 'Managed browser kind.' },
      region: { type: 'string', description: 'Optional screen bounds left,top,right,bottom.' },
      url: { type: 'string', description: 'Optional HTTP/HTTPS URL to enter immediately.' },
      timeout: { type: 'number', description: 'Navigation timeout seconds.' },
    },
    buildArgs: (a) => {
      const args = ['browser', 'open', String(a.browser)]
      if (typeof a.region === 'string' && a.region) args.push('--region', a.region)
      if (typeof a.url === 'string' && a.url) args.push('--url', a.url)
      if (typeof a.timeout === 'number') args.push('--timeout', String(a.timeout))
      return args
    },
  }))

  ctx.tools.register(cliTool({
    name: 'screen_automation_browser_auth_status',
    description: 'Recheck the existing browser after login or verification. Continue only when status is ready. Never write raw cookies or passwords into model context, workflow files, runtime logs or result output.',
    parameters: {
      browser: { type: 'string', required: true, enum: ['chrome', 'edge'] },
    },
    buildArgs: (a) => ['browser', 'auth-status', '--browser', String(a.browser)],
  }))

  ctx.tools.register(cliTool({
    name: 'screen_automation_browser_navigate',
    description: 'Navigate the existing managed browser session. On waiting_for_user, use credentials only when explicitly supplied; otherwise leave the page open and wait. After user confirmation call browser_auth_status and continue the same session. Do not call browser_open again unless browser_session_expired.',
    parameters: {
      browser: { type: 'string', required: true, enum: ['chrome', 'edge'] },
      url: { type: 'string', required: true, description: 'HTTP/HTTPS URL.' },
      timeout: { type: 'number', description: 'Navigation timeout seconds.' },
    },
    buildArgs: (a) => {
      const args = ['browser', 'navigate', '--browser', String(a.browser), String(a.url)]
      if (typeof a.timeout === 'number') args.push('--timeout', String(a.timeout))
      return args
    },
  }))

  ctx.tools.register(cliTool({
    name: 'screen_automation_browser_locate',
    description: 'Locate visible DOM objects in the existing managed browser session. Page changes invalidate prior objects, so locate again after navigation or actions.',
    parameters: {
      browser: { type: 'string', required: true, enum: ['chrome', 'edge'] },
      selector: { type: 'string', description: 'Optional CSS selector.' },
      match_text: { type: 'string', description: 'Optional visible-text filter.' },
      article: { type: 'boolean', description: 'Locate the main article body.' },
      limit: { type: 'number', description: 'Maximum candidates, default 20.' },
    },
    buildArgs: (a) => {
      const args = ['browser', 'locate', '--browser', String(a.browser)]
      if (typeof a.selector === 'string' && a.selector) args.push('--selector', a.selector)
      if (typeof a.match_text === 'string' && a.match_text) args.push('--match-text', a.match_text)
      if (a.article) args.push('--article')
      if (typeof a.limit === 'number') args.push('--limit', String(a.limit))
      return args
    },
  }))

  const browserTargetParameters = (extra: Record<string, any> = {}) => ({
    browser: { type: 'string', required: true, enum: ['chrome', 'edge'] },
    selector: { type: 'string', description: 'CSS selector; omit only when object_json is supplied.' },
    match_text: { type: 'string', description: 'Optional visible-text filter.' },
    index: { type: 'number', description: 'Explicit zero-based candidate index when multiple matches are expected.' },
    object_json: { type: 'string', description: 'Previously located object JSON from the same live session.' },
    ...extra,
  })
  const browserTargetArgs = (command: string, a: any): string[] => {
    const args = ['browser', command, '--browser', String(a.browser)]
    if (typeof a.selector === 'string' && a.selector) args.push('--selector', a.selector)
    if (typeof a.match_text === 'string' && a.match_text) args.push('--match-text', a.match_text)
    if (typeof a.index === 'number') args.push('--index', String(a.index))
    if (typeof a.object_json === 'string' && a.object_json) args.push('--object-json', a.object_json)
    return args
  }

  ctx.tools.register(cliTool({
    name: 'screen_automation_browser_read',
    description: 'Read fields from one uniquely matched visible object in the existing session. Never open or close the browser around this call.',
    parameters: browserTargetParameters({ fields: { type: 'string', description: 'Comma-separated fields, default text.' } }),
    buildArgs: (a) => {
      const args = browserTargetArgs('read', a)
      if (typeof a.fields === 'string' && a.fields) args.push('--fields', a.fields)
      return args
    },
  }))

  for (const operation of [
    ['click', 'Click one uniquely matched visible browser object.'],
    ['select-text', 'Select the visible text of one uniquely matched browser object.'],
  ] as const) {
    ctx.tools.register(cliTool({
      name: `screen_automation_browser_${operation[0].replace('-', '_')}`,
      description: `${operation[1]} Re-locate and verify after the action; keep the same managed session open.`,
      parameters: browserTargetParameters(),
      buildArgs: (a) => browserTargetArgs(operation[0], a),
    }))
  }

  ctx.tools.register(cliTool({
    name: 'screen_automation_browser_fill',
    description: 'Fill one uniquely matched browser field, including a credential authorized by the user. Sensitive text is sent over stdin and must not be written into model context, workflow files, runtime logs or result output.',
    parameters: browserTargetParameters({ text: { type: 'string', required: true } }),
    buildArgs: (a) => [...browserTargetArgs('fill', a), '--text-stdin'],
    stdinText: (a) => String(a.text),
  }))

  ctx.tools.register(cliTool({
    name: 'screen_automation_browser_scroll',
    description: 'Scroll the current managed browser page, then locate/read again because page objects may have changed.',
    parameters: {
      browser: { type: 'string', required: true, enum: ['chrome', 'edge'] },
      x: { type: 'number', description: 'Horizontal delta.' },
      y: { type: 'number', description: 'Vertical delta.' },
    },
    buildArgs: (a) => ['browser', 'scroll', '--browser', String(a.browser), '--x', String(a.x ?? 0), '--y', String(a.y ?? 0)],
  }))

  ctx.tools.register(cliTool({
    name: 'screen_automation_browser_press',
    description: 'Press a key in the current managed browser session and verify the result without reopening the browser.',
    parameters: {
      browser: { type: 'string', required: true, enum: ['chrome', 'edge'] },
      key: { type: 'string', required: true, description: 'Playwright key name such as Enter or Escape.' },
    },
    buildArgs: (a) => ['browser', 'press', '--browser', String(a.browser), String(a.key)],
  }))

  ctx.tools.register(cliTool({
    name: 'screen_automation_browser_copy',
    description: 'Copy one safe field from a uniquely matched browser object. The helper returns bounded metadata and does not log copied content.',
    parameters: browserTargetParameters({ field: { type: 'string', enum: ['text', 'value', 'href'], description: 'Field to copy, default text.' } }),
    buildArgs: (a) => {
      const args = browserTargetArgs('copy', a)
      if (typeof a.field === 'string') args.push('--field', a.field)
      return args
    },
  }))

  ctx.tools.register(cliTool({
    name: 'screen_automation_browser_download',
    description: 'Download through one uniquely matched browser object into the helper-managed download directory.',
    parameters: browserTargetParameters({
      filename: { type: 'string', description: 'Optional safe output filename.' },
      timeout: { type: 'number', description: 'Download timeout seconds.' },
    }),
    buildArgs: (a) => {
      const args = browserTargetArgs('download', a)
      if (typeof a.filename === 'string' && a.filename) args.push('--filename', a.filename)
      if (typeof a.timeout === 'number') args.push('--timeout', String(a.timeout))
      return args
    },
  }))

  ctx.tools.register(cliTool({
    name: 'screen_automation_browser_verify',
    description: 'Verify a browser action against an explicit expectation in the existing session.',
    parameters: {
      browser: { type: 'string', required: true, enum: ['chrome', 'edge'] },
      action_json: { type: 'string', required: true, description: 'Action result JSON.' },
      expectation_json: { type: 'string', required: true, description: 'Verification expectation JSON.' },
    },
    buildArgs: (a) => ['browser', 'verify', '--browser', String(a.browser), '--action-json', String(a.action_json), '--expectation-json', String(a.expectation_json)],
  }))

  ctx.tools.register(cliTool({
    name: 'screen_automation_browser_close',
    description: 'Close the managed browser only after the browser task completes, fails, or the user stops it. Never close between observation and action steps.',
    parameters: { browser: { type: 'string', required: true, enum: ['chrome', 'edge'] } },
    buildArgs: (a) => ['browser', 'close', String(a.browser)],
  }))

  // 3) 列出已安装 workflow
  ctx.tools.register(cliTool({
    name: 'screen_automation_list_workflows',
    description: 'List automation workflows installed in the local Screen Automation Helper platform.',
    parameters: {},
    buildArgs: () => ['workflow', 'list'],
  }))

  // 4) 运行 workflow（核心能力）
  ctx.tools.register(cliTool({
    name: 'screen_automation_run_workflow',
    description:
      'Run an installed automation workflow by id on the local Screen Automation Helper platform. ' +
      'Returns run status/result JSON. Prefer this over raw screen control.',
    parameters: {
      workflow_id: { type: 'string', required: true, description: 'Installed workflow id, e.g. ark-afp-usage-monitor' },
      count: { type: 'number', description: 'Number of times to run (default 1).' },
      dry_run: { type: 'boolean', description: 'Validate the workflow without executing.' },
    },
    buildArgs: (a) => {
      const args = ['start-workflow', String(a.workflow_id)]
      if (typeof a.count === 'number') args.push('--count', String(a.count))
      if (a.dry_run) args.push('--dry-run')
      return args
    },
  }))

  // 5) 停止某个运行
  ctx.tools.register(cliTool({
    name: 'screen_automation_stop_run',
    description: 'Stop a running automation workflow instance by its run id.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Run id returned by screen_automation_run_workflow.' },
    },
    buildArgs: (a) => ['stop', '--run-id', String(a.run_id)],
  }))

  // 6) 列出当前运行
  ctx.tools.register(cliTool({
    name: 'screen_automation_list_runs',
    description: 'List current automation workflow runs on the local platform.',
    parameters: {},
    buildArgs: () => ['runs', 'list'],
  }))

  // 7) 运行前健康检查
  ctx.tools.register(cliTool({
    name: 'screen_automation_health',
    description: 'Run a pre-flight health check for a workflow id on the local platform before running it.',
    parameters: {
      workflow_id: { type: 'string', required: true, description: 'Workflow id to health-check.' },
    },
    buildArgs: (a) => ['health', '--workflow', String(a.workflow_id)],
  }))

  // 8) 屏幕截图 / 识别
  ctx.tools.register(cliTool({
    name: 'screen_automation_capture',
    description:
      'Capture the current screen (or a region) via the local platform and return the image path / ' +
      'recognized text as JSON.',
    parameters: {
      region: { type: 'string', description: 'Optional region spec, e.g. "0,0,800,600".' },
      output: { type: 'string', description: 'Optional output file path for the screenshot.' },
    },
    buildArgs: (a) => {
      const args = ['screen', 'capture']
      if (typeof a.region === 'string') args.push('--region', a.region)
      if (typeof a.output === 'string') args.push('--output', a.output)
      return args
    },
  }))

  // ===== 廉价本地识别层（识别阶梯：OCR / 模板 / 颜色 / 轮廓，免费、本地、省 VLM API） =====

  // 9) OCR 全文识别（返回文字与区域）
  ctx.tools.register(cliTool({
    name: 'screen_automation_recognize_text',
    description:
      'Run local OCR on the screen (or a region) via the helper and return recognized text with ' +
      'bounding boxes as JSON. Free, local, no VLM. Use before spending VLM calls.',
    parameters: {
      region: { type: 'string', description: 'Optional region "x,y,w,h" in pixels.' },
      lang: { type: 'string', description: 'Optional OCR language hint, e.g. "ch" or "en".' },
      text_only: { type: 'boolean', description: 'Return only text without layout boxes.' },
    },
    buildArgs: (a) => {
      const args = ['screen', 'recognize']
      if (typeof a.region === 'string') args.push('--region', a.region)
      if (typeof a.lang === 'string') args.push('--lang', a.lang)
      if (a.text_only) args.push('--text-only')
      return args
    },
  }))

  // 10) 按文字定位（返回坐标）
  ctx.tools.register(cliTool({
    name: 'screen_automation_locate_text',
    description:
      'Find a specific text string on screen via local OCR and return its location/box as JSON. ' +
      'Free, local. Prefer this over VLM for "click the X button" style tasks.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to locate, e.g. "提交".' },
      region: { type: 'string', description: 'Optional region "x,y,w,h".' },
      lang: { type: 'string', description: 'Optional OCR language hint.' },
      min_confidence: { type: 'number', description: 'Minimum match confidence (0..1).' },
    },
    buildArgs: (a) => {
      const args = ['screen', 'find', '--text', String(a.text)]
      if (typeof a.region === 'string') args.push('--region', a.region)
      if (typeof a.lang === 'string') args.push('--lang', a.lang)
      if (typeof a.min_confidence === 'number') args.push('--min-confidence', String(a.min_confidence))
      return args
    },
  }))

  // 11) 颜色区域（HSV 区间）
  ctx.tools.register(cliTool({
    name: 'screen_automation_color_regions',
    description:
      'Find screen regions matching a color range (HSV lower/upper) via local CV. Free, local. ' +
      'Use for "wait until the button turns green" style checks.',
    parameters: {
      lower_hsv: { type: 'string', required: true, description: 'HSV lower bound "h,s,v" (0-255).' },
      upper_hsv: { type: 'string', required: true, description: 'HSV upper bound "h,s,v" (0-255).' },
      region: { type: 'string', description: 'Optional region "x,y,w,h".' },
      min_area: { type: 'number', description: 'Minimum region area in pixels.' },
      max_area: { type: 'number', description: 'Maximum region area in pixels.' },
    },
    buildArgs: (a) => {
      const args = ['screen', 'color-regions', '--lower-hsv', String(a.lower_hsv), '--upper-hsv', String(a.upper_hsv)]
      if (typeof a.region === 'string') args.push('--region', a.region)
      if (typeof a.min_area === 'number') args.push('--min-area', String(a.min_area))
      if (typeof a.max_area === 'number') args.push('--max-area', String(a.max_area))
      return args
    },
  }))

  // 12) 模板匹配（按图找图）
  ctx.tools.register(cliTool({
    name: 'screen_automation_match_template',
    description:
      'Match an image template against the screen via local template matching. Free, local. ' +
      'Use for locating icons/logos by image instead of text.',
    parameters: {
      template: { type: 'string', required: true, description: 'Path to template image file.' },
      region: { type: 'string', description: 'Optional region "x,y,w,h".' },
      threshold: { type: 'number', description: 'Match threshold (0..1, default 0.8).' },
      max_results: { type: 'number', description: 'Max number of matches to return.' },
    },
    buildArgs: (a) => {
      const args = ['screen', 'match', '--template', String(a.template)]
      if (typeof a.region === 'string') args.push('--region', a.region)
      if (typeof a.threshold === 'number') args.push('--threshold', String(a.threshold))
      if (typeof a.max_results === 'number') args.push('--max-results', String(a.max_results))
      return args
    },
  }))

  // 13) 轮廓 / 形状检测
  ctx.tools.register(cliTool({
    name: 'screen_automation_contours',
    description:
      'Detect contours/shapes on screen via local edge detection (CV). Free, local. ' +
      'Use for locating UI elements by shape/size rather than text.',
    parameters: {
      region: { type: 'string', description: 'Optional region "x,y,w,h".' },
      min_width: { type: 'number', description: 'Minimum contour width.' },
      max_width: { type: 'number', description: 'Maximum contour width.' },
      min_height: { type: 'number', description: 'Minimum contour height.' },
      max_height: { type: 'number', description: 'Maximum contour height.' },
      min_area: { type: 'number', description: 'Minimum contour area.' },
      max_area: { type: 'number', description: 'Maximum contour area.' },
    },
    buildArgs: (a) => {
      const args = ['screen', 'contours']
      if (typeof a.region === 'string') args.push('--region', a.region)
      if (typeof a.min_width === 'number') args.push('--min-width', String(a.min_width))
      if (typeof a.max_width === 'number') args.push('--max-width', String(a.max_width))
      if (typeof a.min_height === 'number') args.push('--min-height', String(a.min_height))
      if (typeof a.max_height === 'number') args.push('--max-height', String(a.max_height))
      if (typeof a.min_area === 'number') args.push('--min-area', String(a.min_area))
      if (typeof a.max_area === 'number') args.push('--max-area', String(a.max_area))
      return args
    },
  }))

  // 14) 等待文字出现（廉价状态等待原语）
  ctx.tools.register(cliTool({
    name: 'screen_automation_wait_text',
    description:
      'Poll the screen locally until a specific text appears (or timeout). Free, local. ' +
      'Cheap alternative to a VLM "is the dialog ready?" check.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to wait for.' },
      region: { type: 'string', description: 'Optional region "x,y,w,h".' },
      timeout: { type: 'number', description: 'Max seconds to wait (default 10).' },
      interval: { type: 'number', description: 'Poll interval seconds (default 0.8).' },
      min_confidence: { type: 'number', description: 'Minimum match confidence (0..1).' },
    },
    buildArgs: (a) => {
      const args = ['screen', 'wait', '--text', String(a.text)]
      if (typeof a.region === 'string') args.push('--region', a.region)
      if (typeof a.timeout === 'number') args.push('--timeout', String(a.timeout))
      if (typeof a.interval === 'number') args.push('--interval', String(a.interval))
      if (typeof a.min_confidence === 'number') args.push('--min-confidence', String(a.min_confidence))
      return args
    },
  }))

  // ===== 全控制层（workflow 生命周期 + 本机输入/鼠标，识别阶梯之上的"动手"能力） =====

  // 15) 鼠标点击
  ctx.tools.register(cliTool({
    name: 'screen_automation_click',
    description: 'Click at a screen point via the local helper. Point format "x,y" in pixels.',
    parameters: {
      point: { type: 'string', required: true, description: 'Click point as "x,y".' },
      button: { type: 'string', description: 'Mouse button: left | right | middle (default left).' },
    },
    buildArgs: (a) => {
      const args = ['task', 'click', '--point', String(a.point)]
      if (typeof a.button === 'string') args.push('--button', a.button)
      return args
    },
  }))

  // 16) 拖拽
  ctx.tools.register(cliTool({
    name: 'screen_automation_drag',
    description: 'Drag from one point to another via the local helper. Point format "x,y".',
    parameters: {
      start: { type: 'string', required: true, description: 'Drag start point "x,y".' },
      end: { type: 'string', required: true, description: 'Drag end point "x,y".' },
      duration: { type: 'number', description: 'Drag duration seconds (default 0.5).' },
      button: { type: 'string', description: 'Mouse button: left | right | middle (default left).' },
    },
    buildArgs: (a) => {
      const args = ['task', 'drag', '--start', String(a.start), '--end', String(a.end)]
      if (typeof a.duration === 'number') args.push('--duration', String(a.duration))
      if (typeof a.button === 'string') args.push('--button', a.button)
      return args
    },
  }))

  // 17) 滚动
  ctx.tools.register(cliTool({
    name: 'screen_automation_scroll',
    description: 'Scroll at a screen point via the local helper.',
    parameters: {
      point: { type: 'string', required: true, description: 'Scroll point "x,y".' },
      amount: { type: 'number', required: true, description: 'Scroll amount (positive down, negative up).' },
    },
    buildArgs: (a) => {
      return ['task', 'scroll', '--point', String(a.point), '--amount', String(a.amount)]
    },
  }))

  // 18) 长按
  ctx.tools.register(cliTool({
    name: 'screen_automation_long_press',
    description: 'Long-press at a screen point via the local helper.',
    parameters: {
      point: { type: 'string', required: true, description: 'Press point "x,y".' },
      duration: { type: 'number', description: 'Hold seconds (default 1.0).' },
      button: { type: 'string', description: 'Mouse button: left | right | middle (default left).' },
    },
    buildArgs: (a) => {
      const args = ['task', 'long-press', '--point', String(a.point)]
      if (typeof a.duration === 'number') args.push('--duration', String(a.duration))
      if (typeof a.button === 'string') args.push('--button', a.button)
      return args
    },
  }))

  // 19) 键入文本
  ctx.tools.register(cliTool({
    name: 'screen_automation_type_text',
    description: 'Type user-authorized text into the focused element. Sensitive text is sent over stdin and must not be written into model context, workflow files, runtime logs or result output.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to type.' },
      interval: { type: 'number', description: 'Seconds between keystrokes (default 0.0).' },
    },
    buildArgs: (a) => {
      const args = ['keyboard', 'write', '--text-stdin']
      if (typeof a.interval === 'number') args.push('--interval', String(a.interval))
      return args
    },
    stdinText: (a) => String(a.text),
  }))

  // 20) 组合热键
  ctx.tools.register(cliTool({
    name: 'screen_automation_hotkey',
    description: 'Press a hotkey combination via the local helper, e.g. "ctrl c" or "win v".',
    parameters: {
      keys: { type: 'string', required: true, description: 'Space-separated keys, e.g. "ctrl c".' },
    },
    buildArgs: (a) => {
      const keys = String(a.keys).trim().split(/\s+/).filter(Boolean)
      return ['keyboard', 'hotkey', ...keys]
    },
  }))

  // 21) 校验已安装 workflow
  ctx.tools.register(cliTool({
    name: 'screen_automation_workflow_validate',
    description: 'Validate an installed workflow by id via the local helper CLI. Run this after every workflow change; if it reports an error, stop and fix the workflow instead of guessing unsupported language syntax.',
    parameters: {
      workflow_id: { type: 'string', required: true, description: 'Installed workflow id.' },
    },
    buildArgs: (a) => ['workflow', 'validate', String(a.workflow_id)],
  }))

  // 22) 安装 workflow（从本地源路径）
  ctx.tools.register(cliTool({
    name: 'screen_automation_workflow_install',
    description: 'Install a workflow into the local helper from a source path (directory or archive). Inspect and validate the source against the local helper current workflow language before installing; never invent unsupported workflow fields.',
    parameters: {
      source: { type: 'string', required: true, description: 'Path to workflow source (dir/archive).' },
    },
    buildArgs: (a) => ['workflow', 'install', String(a.source)],
  }))

  // 23) 移除已安装 workflow
  ctx.tools.register(cliTool({
    name: 'screen_automation_workflow_remove',
    description: 'Remove an installed workflow from the local helper by id.',
    parameters: {
      workflow_id: { type: 'string', required: true, description: 'Installed workflow id to remove.' },
    },
    buildArgs: (a) => ['workflow', 'remove', String(a.workflow_id)],
  }))

  // ===== 任务会话（task begin/status/end，把后续控制/识别绑定到一个可见任务窗口） =====

  // 24) 开始任务会话
  ctx.tools.register(cliTool({
    name: 'screen_automation_task_begin',
    description:
      'Begin a task session on the local helper, optionally binding to a window by title/process/handle. ' +
      'Later click/write/find/wait act within this task target. Returns the resolved target as JSON.',
    parameters: {
      title: { type: 'string', description: 'Target window title to match (optional).' },
      process: { type: 'string', description: 'Target process name to match (optional).' },
      handle: { type: 'number', description: 'Target window handle (integer); platform-specific (optional).' },
    },
    buildArgs: (a) => {
      const args = ['task', 'begin']
      if (typeof a.title === 'string' && a.title.length > 0) args.push('--title', String(a.title))
      if (typeof a.process === 'string' && a.process.length > 0) args.push('--process', String(a.process))
      if (typeof a.handle === 'number') args.push('--handle', String(a.handle))
      return args
    },
  }))

  // 25) 任务会话状态
  ctx.tools.register(cliTool({
    name: 'screen_automation_task_status',
    description: 'Report the current task session target (window) on the local helper as JSON.',
    parameters: {},
    buildArgs: () => ['task', 'status'],
  }))

  // 26) 结束任务会话
  ctx.tools.register(cliTool({
    name: 'screen_automation_task_end',
    description: 'End the current task session on the local helper.',
    parameters: {},
    buildArgs: () => ['task', 'end'],
  }))

  // ===== workflow 只读信息工具（show / describe / inspect，无需执行） =====

  // 27) 查看已安装 workflow 详情
  ctx.tools.register(cliTool({
    name: 'screen_automation_workflow_show',
    description: 'Show the resolved configuration/manifest of an installed workflow by id (read-only).',
    parameters: {
      workflow_id: { type: 'string', required: true, description: 'Installed workflow id.' },
    },
    buildArgs: (a) => ['workflow', 'show', String(a.workflow_id)],
  }))

  // 28) 获取 workflow 说明
  ctx.tools.register(cliTool({
    name: 'screen_automation_workflow_describe',
    description: 'Return the human-readable description/metadata of an installed workflow by id (read-only).',
    parameters: {
      workflow_id: { type: 'string', required: true, description: 'Installed workflow id.' },
    },
    buildArgs: (a) => ['workflow', 'describe', String(a.workflow_id)],
  }))

  // 29) 检查 workflow 源（未安装也能看）
  ctx.tools.register(cliTool({
    name: 'screen_automation_workflow_inspect',
    description: 'Inspect and validate a workflow source (directory/archive) without installing it; returns validated source metadata as JSON. Use before installing or upgrading a workflow.',
    parameters: {
      source: { type: 'string', required: true, description: 'Path to workflow source (dir/archive).' },
    },
    buildArgs: (a) => ['workflow', 'inspect', String(a.source)],
  }))

  // 30) 把小助手截图喂给 dsh 的视觉模型（识别阶梯的最高层：VLM 理解屏幕）
  // 流程：screen capture 拿图 → ctx.attachments 登记为不可变图片引用 →
  //       拼一个含 image block 的 user 消息 → ctx.llm.stream 多模态推理 → 收集 text-delta。
  // 注意：模型走的是 dsh 当前 profile 配置的 provider。默认 deepseek-official 提供方的
  //       deepseek-v4-flash-vision-exp 就是视觉模型，可直接用于屏幕理解；若想改用
  //       本机模型，用环境变量 SCREEN_AUTOMATION_VISION_PROVIDER / _MODEL 配置，或每次
  //       调用传 provider/model（例如本机 Ollama 的 qwen2.5-vl）。understand 依赖
  //       ctx.llm 与 ctx.attachments，已在插件顶层 inject 中声明。
  ctx.tools.register(defineTool({
    name: 'screen_automation_understand',
    description:
      'Capture the screen via the local helper and feed the screenshot to the dsh vision model. ' +
      'Returns the model\'s natural-language understanding of what is on screen. ' +
      'Use this for open-ended tasks OCR/template/color cannot solve (e.g. "what is this screen doing", "where did it error"). ' +
      'Requires the local Screen Automation Helper desktop app to be installed and running. ' +
      'If a "binary not found" error is returned, STOP and tell the user to install it ' +
      '(share the Windows/macOS/ZIP download links in the error) before retrying.',
    parameters: {
      prompt: { type: 'string', description: 'What to ask about the screenshot. Defaults to a general description request.' },
      target: { type: 'string', description: 'Capture target: foreground | virtual-screen | work-area | task. Default foreground.' },
      region: { type: 'string', description: 'Optional capture region in helper format (e.g. "0,0,800,600").' },
      provider: { type: 'string', description: 'dsh LLM provider route for vision. Falls back to env SCREEN_AUTOMATION_VISION_PROVIDER, then "deepseek-official".' },
      model: { type: 'string', description: 'Vision model id under the provider. Falls back to env SCREEN_AUTOMATION_VISION_MODEL, then "deepseek-v4-flash-vision-exp".' },
      system: { type: 'string', description: 'Optional system prompt for the vision call.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          attachmentId: { type: 'string', required: true },
          imageBytes: { type: 'number', required: true },
          captureCommand: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const v = value as { text?: string; provider?: string; model?: string }
        const head = `[${v.provider ?? '?'} / ${v.model ?? '?'}]`
        return [{ type: 'text', text: `${head}\n${v.text ?? ''}` }]
      },
    },
    async execute(args) {
      const bin = resolveBinary()
      if (!bin) {
        throw new Error(INSTALL_HINT)
      }
      if (!ctx.llm) {
        throw new Error('dsh LLM service (ctx.llm) is unavailable in this profile; cannot run vision understanding.')
      }
      if (!ctx.attachments) {
        throw new Error('dsh attachment service (ctx.attachments) is unavailable in this profile; cannot register the screenshot.')
      }

      const provider =
        (typeof args.provider === 'string' && args.provider.trim())
          ? args.provider.trim()
          : (process.env.SCREEN_AUTOMATION_VISION_PROVIDER?.trim() || 'deepseek-official')
      const model =
        (typeof args.model === 'string' && args.model.trim())
          ? args.model.trim()
          : (process.env.SCREEN_AUTOMATION_VISION_MODEL?.trim() || 'deepseek-v4-flash-vision-exp')
      const modelInfo = await ctx.llm.resolveModelInfo(provider, model)
      if (!modelInfo.inputModalities?.includes('image')) {
        throw new Error(`dsh model ${provider}/${model} does not declare image input; screenshot was not captured.`)
      }

      // 1) 能力确认通过后再让小助手截图，输出到我们可控的临时文件
      const target = typeof args.target === 'string' && args.target.trim() ? args.target.trim() : 'foreground'
      const region = typeof args.region === 'string' && args.region.trim() ? args.region.trim() : undefined
      const outPath = path.join(os.tmpdir(), `dsh-sa-capture-${process.pid}-${Date.now()}.png`)
      const capArgs = ['screen', 'capture', '--target', target, '--output', outPath]
      if (region) capArgs.push('--region', region)
      const cap = await runCli(capArgs)

      // 截图可能写到 outPath，也可能在 JSON 里回一个路径；谁存在用谁
      let imgPath = outPath
      if (!fs.existsSync(imgPath)) {
        const reported = (cap.data && (cap.data.path || cap.data.output || cap.data.file)) as string | undefined
        if (reported && fs.existsSync(reported)) imgPath = reported
      }
      if (!fs.existsSync(imgPath)) {
        throw new Error(`screenshot capture produced no file (cmd: ${cap.command}; raw: ${cap.raw.slice(0, 200)})`)
      }

      // 2) 读字节 + 推断媒体类型
      const buf = fs.readFileSync(imgPath)
      const lower = imgPath.toLowerCase()
      const mediaType: ImageMediaType = lower.endsWith('.jpg') || lower.endsWith('.jpeg')
        ? 'image/jpeg'
        : lower.endsWith('.webp')
          ? 'image/webp'
          : 'image/png'

      // 3) 登记为 attachment 服务里的不可变图片引用（dsh 契约要求走 attachment，而非裸 base64）
      const ref: ImageAttachmentRef = await ctx.attachments.saveImage({
        data: new Uint8Array(buf),
        mediaType,
        name: 'screen-capture',
      } as SaveImageAttachment)

      // 4) 拼多模态 user 消息：文字提问 + 图片块
      const promptText =
        typeof args.prompt === 'string' && args.prompt.trim()
          ? args.prompt.trim()
          : 'Describe what is shown in this screenshot, focusing on actionable UI elements.'
      const userContent: ContentBlock[] = [
        { type: 'text', text: promptText },
        { type: 'image', attachment: ref } as ImageBlock,
      ]
      const userMessage: Message = {
        id: MessageId(`screen-understand-${Date.now()}`),
        role: 'user',
        content: userContent,
        source: { kind: 'user' },
      }

      // 5) 走 dsh 当前 profile 的视觉模型（可传 provider/model 指向本地模型）。
      //    优先级：调用参数 > 环境变量(整 profile 统一默认) > hardcoded 兜底。
      //    默认 deepseek-official 提供方的 deepseek-v4-flash-vision-exp 即视觉模型；
      //    想换本机模型（如 qwen2.5-vl）就靠 provider/model 或环境变量覆盖。
      let text = ''
      for await (const chunk of ctx.llm.stream({
        provider,
        model,
        messages: [userMessage],
        system: typeof args.system === 'string' && args.system.trim() ? args.system.trim() : undefined,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
      }

      return {
        ok: true,
        text,
        provider,
        model,
        attachmentId: ref.attachmentId,
        imageBytes: buf.length,
        captureCommand: cap.command,
      }
    },
  }))

  console.log('[screen-automation] loaded; bridged tools: status, capabilities, browser enhancement, list/run/stop workflows, runs, health, capture, ' +
    'recognize_text, locate_text, color_regions, match_template, contours, wait_text, ' +
    'click, drag, scroll, long_press, type_text, hotkey, ' +
    'workflow_validate/install/remove/show/describe/inspect, task_begin/status/end, ' +
    'understand(vlm)')
}
