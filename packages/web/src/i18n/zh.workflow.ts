/** workflow 命名空间（zh 权威）*/
export const zh: Record<string, string> = {
  // 使用指引
  'workflow.guideOpen': '什么是 Graph 模式？怎么用？',
  'workflow.guideTitle': 'Workflow（Graph 模式）使用指引',
  'workflow.collapse': '收起',
  'workflow.guideDiffTitle': '和「对话」模式的区别',
  'workflow.guideDiffA': '：对话里 Agent 自主决定下一步（自由但每次路径可能不同）；Workflow 把步骤',
  'workflow.guideDiffB': '预先写成一张确定的依赖图（DAG）',
  'workflow.guideDiffC': '——哪个节点先跑、结果传给谁，全部由你定义，模型只负责执行每个节点。适合可重复的固定流程。',
  'workflow.guideStepsTitle': '三步使用',
  'workflow.guideStepsA': '：① 在「目标描述」写一句话点 ',
  'workflow.guideStepsB': '（自动生成 YAML，也可手写）→ ② 点',
  'workflow.guideStepsC': '确认无误 → ③ 点',
  'workflow.guideStepsD': '，下方实时显示每个节点的状态与产出。',
  'workflow.guideApprovalTitle': '节点级审批',
  'workflow.guideApprovalA': '：给节点写 ',
  'workflow.guideApprovalB': '，它执行前会',
  'workflow.guideApprovalPause': '暂停等你批准',
  'workflow.guideApprovalC': '（run 显示 waiting_human）。「审批中心」页汇聚了所有等待中的审批（含对话模式的文件修改审批）：可以',
  'workflow.guideApprovalOps': '通过 / 拒绝 / 先修改参数 JSON 再通过',
  'workflow.guideApprovalD': '——改完的参数就是该节点实际使用的输入。',
  'workflow.guideResumeTitle': '断点恢复',
  'workflow.guideResumeA': '：Graph 每完成一个节点就存档（checkpoint）。如果服务中途重启，页面顶部会出现黄色横幅列出中断的 run——点「恢复」从断点继续，',
  'workflow.guideResumeB': '已完成的节点不会重跑',
  'workflow.guideResumeC': '，只有未完成的继续执行。',
  // 页头 / 中断恢复条
  'workflow.subtitle': 'Graph 模式 — 确定性 DAG · 节点级审批 · 断点恢复',
  'workflow.resumableDetected': '检测到 {n} 个因服务重启中断的 graph run（已完成节点不会重跑）',
  'workflow.resume': '恢复',
  // YAML 编辑器
  'workflow.yamlTitle': 'Graph YAML（草稿自动保存）',
  'workflow.validate': '校验',
  'workflow.validateOk': '✓ 校验通过 · 拓扑序: {order}',
  'workflow.defaultYaml': `name: my-workflow
description: 示例：读取网页并总结（替换为你的技能编排）
max_parallel: 2
input:
  url: https://example.com
nodes:
  - id: read
    type: skill
    skill: web-reader
    input:
      url: "\${{ input.url }}"
  - id: summarize
    type: skill
    skill: summarize-document
    input:
      text: "\${{ nodes.read.outputs.text }}"
    retries: 1
edges:
  - { from: read, to: summarize }
`,
  // 运行面板
  'workflow.run': '运行',
  'workflow.goalPlaceholder': '目标描述（AI 编排必填；运行时可选）',
  'workflow.runInputPlaceholder': '运行输入 JSON（可选，覆盖 graph 里的 input 默认值），如 {"url": "https://..."}',
  'workflow.artifactDir': '产物目录',
  'workflow.wsTemp': '系统临时目录（不保存）',
  'workflow.wsOption': '工作区 · {name}',
  'workflow.wsHint': '文档等产物将保存到所选工作区文件夹（可在资源管理器中直接打开）',
  'workflow.aiCompose': 'AI 编排',
  'workflow.runGraph': '运行 Graph',
  'workflow.cancel': '取消',
  // 运行态
  'workflow.nodePreview': '节点预览: {nodes}',
  'workflow.noNodes': '（未识别到节点）',
  'workflow.connected': '● 已连接',
  'workflow.connecting': '○ 连接中…',
  'workflow.running': '运行中',
  'workflow.runFailedTitle': 'Graph 执行失败：',
  'workflow.nodePrefix': '节点 ',
  'workflow.nodeFailedSkill': '（{skill}）：',
  'workflow.unknownError': '未知错误',
  'workflow.commonCauses': '常见原因：技能名写错（先到「技能列表」核对）、技能执行报错（看上方节点列表的错误信息）。',
  'workflow.resultsTitle': '执行结果（{n} 个节点产出）',
  'workflow.approvalWaiting': ' 等待审批 — 可修改参数后通过（也可到「审批中心」处理）',
  'workflow.approve': '通过并继续',
  'workflow.reject': '拒绝',
  // 错误提示（页面内错误框）
  'workflow.errGoalRequired': '请先在运行面板填写目标描述',
  'workflow.errCompileFailed': 'AI 编排失败: {msg}',
  'workflow.errRunInputJson': '运行输入不是合法 JSON',
  'workflow.errCreateFailed': '创建失败',
  'workflow.errParamJson': '参数 JSON 不合法',
};
