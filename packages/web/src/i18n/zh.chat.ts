/** chat 命名空间（zh 权威）*/
export const zh: Record<string, string> = {
  // 页头 / 侧栏
  'chat.title': 'Agent 会话',
  'chat.subtitle': '自主规划 · 工具调用 · 全程可观测',
  'chat.liveConnected': '· 实时已连接',
  'chat.history': '历史会话',
  'chat.startNewSession': '开始新会话',
  'chat.new': '新建',
  'chat.noHistory': '暂无历史',
  'chat.conversation': '对话',
  'chat.turns': '{count} 轮',
  'chat.threadsRuns': '{threads} 线 · {runs} 轮',
  'chat.threadListHint': '对话线（互不影响，可独立打开/删除）：',
  'chat.deleteThread': '删除此条对话线',
  'chat.deleteConversation': '删除此对话',

  // 状态徽章
  'chat.statusCreated': '已创建',
  'chat.statusRunning': '运行中',
  'chat.statusWaitingApproval': '等待审批',
  'chat.statusCompleted': '已完成',
  'chat.statusFailed': '已失败',
  'chat.statusCancelled': '已取消',

  // 用量指示器
  'chat.contextUsageTooltip': '消息 {messages} 条 · 会话文件 {files} 个',
  'chat.tokenUsageTooltip': '本轮 run 的 token 累计消耗（输入+输出）/ 预算上限。预算可在设置页调整',
  'chat.wanUnit': '万',

  // 工作区
  'chat.workspaceUnbound': '未绑定工作区',
  'chat.workspaceDontBind': '不绑定工作区',
  'chat.newWorkspaceOption': '＋ 新建工作区…',
  'chat.newWorkspaceTitle': '新建工作区',
  'chat.permissionTitle': '工作区权限档：写改是否需要审批',
  'chat.permissionLabel': '权限档',
  'chat.permReadonly': '只读',
  'chat.permAsk': '写改询问',
  'chat.permAuto': '全自动',
  'chat.permAskFull': '询问（默认，写改弹 diff 批准）',
  'chat.permAutoFull': '全自动（写改直接执行）',
  'chat.nameLabel': '名称',
  'chat.workspaceNamePlaceholder': '我的项目',
  'chat.workspaceDirLabel': '本地文件夹完整路径（须已存在）',
  'chat.workspaceDirHint': '提示：资源管理器地址栏复制路径粘贴即可',
  'chat.createAndUse': '创建并使用',
  'chat.permissionChangeFailed': '权限修改失败: {message}',

  // 空态 / 示例
  'chat.emptyGoalTitle': '描述你的目标',
  'chat.emptyGoalDesc': 'Agent 会自主调用工具完成；绑定工作区后可读写本地文件',
  'chat.exampleSummarize': '总结 https://example.com 的要点',
  'chat.exampleWorkspaceFiles': '看看工作区里有什么文件',
  'chat.exampleNotesToTable': '把笔记整理成表格',

  // 会话线程
  'chat.branchLine': '分支线（从原对话第 {seq} 步分出）',
  'chat.inheritedReadonly': '· 以下为继承的问答（只读）',

  // 产物
  'chat.artifactsProduced': '本次产出 ·',
  'chat.artifactsInProgress': '产出中 ·',
  'chat.clickToPreview': '{file}（点击预览）',
  'chat.actionModify': '改',

  // 预览抽屉
  'chat.previewNoWorkspace': '未绑定工作区 — 请先在顶部选择工作区',
  'chat.previewFailed': '预览失败',
  'chat.download': '下载',
  'chat.closePreview': '关闭预览',
  'chat.loadingPreview': '加载预览…',
  'chat.pdfPreview': 'PDF 预览',
  'chat.previewUnsupported': '此格式暂不支持在线预览',
  'chat.downloadToView': '下载查看',

  // 输入区
  'chat.attachmentStagingHint': '将随下一条消息一并发送，发送后自动移除',
  'chat.removeFromList': '从列表移除',
  'chat.slashHint': '斜杠命令 — ↑↓ 选择 · Tab/Enter 补全 · Esc 关闭',
  'chat.atFileHint': '引用工作区文件 — ↑↓ 选择 · Tab/Enter 插入 · Esc 关闭',
  'chat.goalPlaceholder': '描述你的目标…（输入 / 唤起快捷命令；Enter 发送，Shift+Enter 换行）',
  'chat.uploadToWorkspace': '上传文件到工作区',
  'chat.uploadNeedWorkspaceFirst': '先在设置页创建工作区，才能上传文件',
  'chat.uploadNeedWorkspaceAlert': '上传需要先绑定工作区：请到「设置」页创建工作区（绑定一个本地文件夹），然后在顶部选择它。',
  'chat.uploadNeedWorkspace': '请先选择工作区再上传',
  'chat.uploadFileTooLarge': '文件超过 1MB 上限',
  'chat.uploadFailed': '上传失败: {message}',

  // 提示词优化
  'chat.promptOptimize': '提示词优化',
  'chat.optimizeButtonTitle': '优化提示词 — 理解你的意图后改写，让 AI 完成得更好',
  'chat.optimizeEmptyDraft': '先写点什么再优化～',
  'chat.optimizeFailed': '优化失败',
  'chat.optimizing': '正在理解你的意图并优化…',
  'chat.viewOriginal': '看原文',
  'chat.close': '关闭',
  'chat.discard': '放弃',
  'chat.applyOptimized': '采用（替换输入框）',

  // 运行 / 错误提示
  'chat.createRunFailed': '创建失败: {message}',
  'chat.approvalFailed': '审批失败: {message}',
  'chat.continueFailed': '续接失败: {message}',
  'chat.confirmDeleteRun': '删除这条对话？（事件与检查点一并删除）',
  'chat.deleteFailed': '删除失败: {message}',
  'chat.deleteSessionNotGrouped': '该对话不属于任何会话，请删除单条对话',
  'chat.confirmDeleteSession': '删除整个会话（含全部对话记录）？',
  'chat.cancel': '取消',

  // 执行过程
  'chat.executing': '正在执行…',
  'chat.executionProcess': '执行过程',
  'chat.toolCallsCount': '{count} 次工具调用',
  'chat.todosProgress': '{done}/{total} 项任务',
  'chat.loadingEvents': '加载事件中…',

  // 直播视图
  'chat.approvalNeeded': '需要你的批准：{tool}',
  'chat.reject': '拒绝',
  'chat.approveExecution': '批准执行',
  'chat.budgetExceeded': '⚠ 预算达到上限，以上为部分成果总结',
  'chat.continueRun': '继续执行',
  'chat.eventCount': '{count} 个事件',
  'chat.waitingEvents': '等待事件…',
  'chat.waitingEventsDesc': 'run 已创建，正在等待第一条事件',
};
