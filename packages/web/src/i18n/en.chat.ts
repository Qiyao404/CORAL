/** chat namespace (en) */
export const en: Record<string, string> = {
  // Header / sidebar
  'chat.title': 'Agent Chat',
  'chat.subtitle': 'Autonomous planning · Tool calls · Fully observable',
  'chat.liveConnected': '· Realtime connected',
  'chat.history': 'History',
  'chat.startNewSession': 'Start a new session',
  'chat.new': 'New',
  'chat.noHistory': 'No history yet',
  'chat.conversation': 'Conversation',
  'chat.turns': '{count} turns',
  'chat.threadsRuns': '{threads} threads · {runs} turns',
  'chat.threadListHint': 'Conversation threads (independent; open or delete each one):',
  'chat.deleteThread': 'Delete this thread',
  'chat.deleteConversation': 'Delete this conversation',

  // Status badges
  'chat.statusCreated': 'Created',
  'chat.statusRunning': 'Running',
  'chat.statusWaitingApproval': 'Awaiting approval',
  'chat.statusCompleted': 'Completed',
  'chat.statusFailed': 'Failed',
  'chat.statusCancelled': 'Cancelled',

  // Usage indicators
  'chat.contextUsageTooltip': '{messages} messages · {files} session files',
  'chat.tokenUsageTooltip': 'Tokens used this run (input+output) / budget cap. Adjust the budget on the Settings page.',
  'chat.wanUnit': 'w',

  // Workspace
  'chat.workspaceUnbound': 'No workspace bound',
  'chat.workspaceDontBind': "Don't bind a workspace",
  'chat.newWorkspaceOption': '+ New workspace…',
  'chat.newWorkspaceTitle': 'New workspace',
  'chat.permissionTitle': 'Workspace permission level: whether writes need approval',
  'chat.permissionLabel': 'Permission level',
  'chat.permReadonly': 'Read-only',
  'chat.permAsk': 'Ask before writes',
  'chat.permAuto': 'Fully automatic',
  'chat.permAskFull': 'Ask (default; shows a diff for approval on writes)',
  'chat.permAutoFull': 'Fully automatic (writes execute directly)',
  'chat.nameLabel': 'Name',
  'chat.workspaceNamePlaceholder': 'My project',
  'chat.workspaceDirLabel': 'Full local folder path (must already exist)',
  'chat.workspaceDirHint': "Tip: copy the path from File Explorer's address bar and paste it here",
  'chat.createAndUse': 'Create and use',
  'chat.permissionChangeFailed': 'Failed to change permission: {message}',

  // Empty state / examples
  'chat.emptyGoalTitle': 'Describe your goal',
  'chat.emptyGoalDesc': 'The agent calls tools autonomously to get it done; bind a workspace to read and write local files',
  'chat.exampleSummarize': 'Summarize the key points of https://example.com',
  'chat.exampleWorkspaceFiles': 'See what files are in the workspace',
  'chat.exampleNotesToTable': 'Turn my notes into a table',

  // Session thread
  'chat.branchLine': 'Branch (forked from step {seq} of the original conversation)',
  'chat.inheritedReadonly': '· Inherited Q&A below (read-only)',

  // Artifacts
  'chat.artifactsProduced': 'Artifacts ·',
  'chat.artifactsInProgress': 'Producing ·',
  'chat.clickToPreview': '{file} (click to preview)',
  'chat.actionModify': 'Edit',

  // Preview drawer
  'chat.previewNoWorkspace': 'No workspace bound — select one at the top first',
  'chat.previewFailed': 'Preview failed',
  'chat.download': 'Download',
  'chat.closePreview': 'Close preview',
  'chat.loadingPreview': 'Loading preview…',
  'chat.pdfPreview': 'PDF preview',
  'chat.previewUnsupported': 'Online preview is not supported for this format yet',
  'chat.downloadToView': 'Download to view',

  // Input area
  'chat.attachmentStagingHint': 'Sent with your next message, then removed automatically',
  'chat.removeFromList': 'Remove from list',
  'chat.slashHint': 'Slash commands — ↑↓ select · Tab/Enter complete · Esc close',
  'chat.atFileHint': 'Reference workspace files — ↑↓ select · Tab/Enter insert · Esc close',
  'chat.goalPlaceholder': 'Describe your goal… (type / for quick commands; Enter to send, Shift+Enter for a new line)',
  'chat.uploadToWorkspace': 'Upload files to the workspace',
  'chat.uploadNeedWorkspaceFirst': 'Create a workspace in Settings before uploading files',
  'chat.uploadNeedWorkspaceAlert': 'Uploading requires a workspace: create one on the Settings page (binding a local folder), then select it at the top.',
  'chat.uploadNeedWorkspace': 'Select a workspace before uploading',
  'chat.uploadFileTooLarge': 'File exceeds the 1MB limit',
  'chat.uploadFailed': 'Upload failed: {message}',

  // Prompt optimizer
  'chat.promptOptimize': 'Prompt optimization',
  'chat.optimizeButtonTitle': 'Optimize prompt — rewrites it around your intent so the AI does better',
  'chat.optimizeEmptyDraft': 'Write something first, then optimize~',
  'chat.optimizeFailed': 'Optimization failed',
  'chat.optimizing': 'Understanding your intent and optimizing…',
  'chat.viewOriginal': 'View original',
  'chat.close': 'Close',
  'chat.discard': 'Discard',
  'chat.applyOptimized': 'Apply (replaces the input)',

  // Run / error alerts
  'chat.createRunFailed': 'Failed to create: {message}',
  'chat.approvalFailed': 'Approval failed: {message}',
  'chat.continueFailed': 'Continue failed: {message}',
  'chat.confirmDeleteRun': 'Delete this conversation? (Events and checkpoints will be deleted too)',
  'chat.deleteFailed': 'Delete failed: {message}',
  'chat.deleteSessionNotGrouped': "This conversation doesn't belong to any session; delete the single conversation instead",
  'chat.confirmDeleteSession': 'Delete the entire session (including all conversation history)?',
  'chat.cancel': 'Cancel',

  // Execution process
  'chat.executing': 'Running…',
  'chat.executionProcess': 'Execution process',
  'chat.toolCallsCount': '{count} tool calls',
  'chat.todosProgress': '{done}/{total} tasks',
  'chat.loadingEvents': 'Loading events…',

  // Live view
  'chat.approvalNeeded': 'Approval needed: {tool}',
  'chat.reject': 'Reject',
  'chat.approveExecution': 'Approve execution',
  'chat.budgetExceeded': '⚠ Budget limit reached; the above is a partial summary',
  'chat.continueRun': 'Continue',
  'chat.eventCount': '{count} events',
  'chat.waitingEvents': 'Waiting for events…',
  'chat.waitingEventsDesc': 'Run created; waiting for the first event',
};
