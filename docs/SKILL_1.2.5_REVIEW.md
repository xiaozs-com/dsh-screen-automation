# Skill／专家 1.2.5 对齐检查（2026-10-20）

核对源：`D:/ai/screen-automation/skills/screen-automation/SKILL.md`（version 1.2.5）、
同目录 references 的 workflow-standard、workflow-agent-phases、agent-bridge、workflow-lifecycle，
以及 `D:/ai/screen-automation-helper/runtime/cli.py` 的实际 argparse 和分派接口。
本插件保持 CLI JSON 桥接职责，规范正文由 screen-automation 仓库维护。

| 检查项 | 核实结果与处理 |
|---|---|
| 登录、授权、支付及高风险操作 | 原 open/navigate/fill 描述及 README 允许代填凭据。已移除，并为所有工具添加一致的用户在场边界；普通输入仅用于非敏感字段，stdin 传输保留。 |
| 浏览器关闭 | 原描述允许任务结束即关闭。改为默认保留现场，只在用户明确要求或授权流程步骤显式声明时关闭；受管会话复用、过期重开和 waiting_for_user 保留。 |
| 自描述、访问状态、阶段 SDK、接入诊断 | 已核对 CLI 并新增 describe、access_list、access_status、workflow_schema、workflow_sdk、agent_status、agent_probe，共 7 个工具。未增加激活码或 Provider 凭据写入工具。 |
| 工作流规范与语言 3 | 旧仓库链接已替换为当前原子 Skill 标准和阶段参考；工具描述引导查询安装版 steps schema/SDK，保持桥接透传，不复制语言规范正文。 |
| inspect / validate | 本地目录或 ZIP 使用 inspect；安装后按 id validate；错误时修复源并重新安装校验。可信 Python 代码的 AST/权限检查不是系统沙箱。 |
| 停止状态 | stop 说明改为发出请求后读取 runs，区分 stopping、finalizing、结束及 stopped:false；task_end 说明默认保留窗口。 |
| 数量及安装说明 | README 移除分散的固定数量；测试核对当前注册 55 个工具。用户 npm 安装与开发源码挂载分别说明；纠正鼠标键盘 CLI 映射和发布 Secret 名称。 |
| 工具白名单 | 原 CLI 工具执行校验保留；发现独立 understand 工具漏检，已补执行前拒绝，并覆盖回归测试。 |
| 视觉模型及隐私 | 保留截图前 image 能力预检；新增必填 external_capture_confirmed，未确认在截图前拒绝。该布尔值是 Agent 完成确认的声明，不是系统级隐私隔离。 |

## 验证

`npm test` 构建后运行原生子进程桩测试，覆盖新 CLI 参数、schema 非法值、注册数量、
白名单拒绝、stdin 非敏感输入、模型不支持图片时提前拒绝，以及确认后的截图／attachment／模型文本链路。
`npm pack` 生成独立 0.1.10 包，核对 README、cordis.patch.yml、lib/index.js、lib/index.d.ts、package.json。
CI 增加 npm test；不修改任何发布触发器。

上述是接口和桩测试验收，不代表真实 DSH Profile、已安装桌面端、真实 Provider、实际业务或 macOS 真机验收。
本次本地构建打包，不提交发布标签、不发布 npm。
