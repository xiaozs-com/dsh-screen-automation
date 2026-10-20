import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, isToolAllowedByBridge } from '../lib/index.js'

const tools = new Map()
let visionCalls = 0
const ctx = {
  tools: { register(tool) { assert.ok(!tools.has(tool.name)); tools.set(tool.name, tool) } },
  llm: {
    resolveModelInfo: async () => ({ inputModalities: ['text'] }),
    async *stream() { visionCalls++; yield { type: 'text-delta', text: 'observed' } },
  },
  attachments: { saveImage: async () => ({ attachmentId: 'test-image' }) },
}
apply(ctx)
assert.equal(tools.size, 55)
const invoke = (name, args = {}) => tools.get(`screen_automation_${name}`).execute(args)

test('task allowlists fail closed for missing/unknown policy and empty lists', () => {
  assert.equal(isToolAllowedByBridge('x', {}), true)
  for (const env of [
    { SCREEN_AUTOMATION_AGENT_TOOL_POLICY_VERSION: '1' },
    { SCREEN_AUTOMATION_AGENT_ALLOWED_TOOLS: 'x' },
    { SCREEN_AUTOMATION_AGENT_TOOL_POLICY_VERSION: '2', SCREEN_AUTOMATION_AGENT_ALLOWED_TOOLS: 'x' },
    { SCREEN_AUTOMATION_AGENT_TOOL_POLICY_VERSION: '1', SCREEN_AUTOMATION_AGENT_ALLOWED_TOOLS: '' },
  ]) assert.equal(isToolAllowedByBridge('x', env), false)
  assert.equal(isToolAllowedByBridge('x', { SCREEN_AUTOMATION_AGENT_TOOL_POLICY_VERSION: '1', SCREEN_AUTOMATION_AGENT_ALLOWED_TOOLS: 'x,y' }), true)
})

test('registered tools enforce boundary and new CLI mappings through native process transport', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-test-'))
  const cwd = process.cwd()
  const previous = { ...process.env }
  try {
    // Node acts as a stub native helper: runCli invokes node cli <arguments>.
    fs.writeFileSync(path.join(dir, 'cli'), `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      if (args[0] === 'screen' && args[1] === 'capture') {
        fs.writeFileSync(args[args.indexOf('--output') + 1], Buffer.from('iVBORw0KGgo=', 'base64'));
      }
      if (args.includes('--text-stdin')) {
        let text = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => text += chunk);
        process.stdin.on('end', () => process.stdout.write(JSON.stringify({args, text})));
      } else process.stdout.write(JSON.stringify({args}));
    `)
    process.chdir(dir)
    process.env.SCREEN_AUTOMATION_BIN = process.execPath
    process.env.TEMP = dir
    process.env.TMP = dir
    process.env.TMPDIR = dir
    delete process.env.SCREEN_AUTOMATION_AGENT_TOOL_POLICY_VERSION
    delete process.env.SCREEN_AUTOMATION_AGENT_ALLOWED_TOOLS
    for (const [name, args, expected] of [
      ['describe', {}, ['describe']], ['access_list', {}, ['access', 'list']],
      ['access_status', { capability_id: 'browser-enhancement' }, ['access', 'status', 'browser-enhancement']],
      ['workflow_schema', { target: 'steps' }, ['workflow', 'schema', 'steps']],
      ['workflow_sdk', {}, ['workflow', 'sdk']], ['agent_status', {}, ['agent', 'status']],
      ['agent_probe', {}, ['agent', 'probe']],
      ['workflow_inspect', { source: 'draft folder' }, ['workflow', 'inspect', 'draft folder']],
      ['workflow_validate', { workflow_id: 'installed-id' }, ['workflow', 'validate', 'installed-id']],
      ['browser_open', { browser: 'chrome' }, ['browser', 'open', 'chrome']],
      ['browser_close', { browser: 'chrome' }, ['browser', 'close', 'chrome']],
    ]) assert.deepEqual((await invoke(name, args)).data.args, expected)
    const typed = await invoke('type_text', { text: 'ordinary form text' })
    assert.equal(typed.data.text, 'ordinary form text')
    assert.ok(!typed.command.includes('ordinary form text'))
    await assert.rejects(invoke('workflow_schema', { target: 'invented' }))
    for (const tool of tools.values()) assert.match(tool.description, /User-present boundary/)
    assert.match(tools.get('screen_automation_browser_close').description, /Preserve the browser by default/)
    process.env.SCREEN_AUTOMATION_AGENT_TOOL_POLICY_VERSION = '1'
    process.env.SCREEN_AUTOMATION_AGENT_ALLOWED_TOOLS = 'screen_automation_status'
    await assert.rejects(invoke('describe'), /denied/)
    await assert.rejects(invoke('understand', { external_capture_confirmed: true }), /denied/)
    delete process.env.SCREEN_AUTOMATION_AGENT_TOOL_POLICY_VERSION
    delete process.env.SCREEN_AUTOMATION_AGENT_ALLOWED_TOOLS
    await assert.rejects(invoke('understand', { external_capture_confirmed: false }), /Confirm screenshot/)
    // Model validation must reject before invoking screen capture or attachment upload.
    await assert.rejects(invoke('understand', { external_capture_confirmed: true }), /does not declare image input/)
    assert.equal(visionCalls, 0)
    ctx.llm.resolveModelInfo = async () => ({ inputModalities: ['image'] })
    const understood = await invoke('understand', { external_capture_confirmed: true })
    assert.equal(understood.text, 'observed')
    assert.equal(understood.attachmentId, 'test-image')
    assert.equal(visionCalls, 1)
  } finally {
    process.chdir(cwd)
    process.env = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
