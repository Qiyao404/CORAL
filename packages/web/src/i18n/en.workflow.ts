/** workflow namespace (en) */
export const en: Record<string, string> = {
  // Guide
  'workflow.guideOpen': 'What is Graph mode? How do I use it?',
  'workflow.guideTitle': 'Workflow (Graph mode) guide',
  'workflow.collapse': 'Collapse',
  'workflow.guideDiffTitle': 'How it differs from Chat mode',
  'workflow.guideDiffA': ': in Chat, the Agent decides each next step itself (flexible, but the path may differ every time); Workflow has you ',
  'workflow.guideDiffB': 'pre-write the steps as a fixed dependency graph (DAG)',
  'workflow.guideDiffC': ' — which node runs first and where its result goes are all defined by you; the model just executes each node. Ideal for repeatable, fixed processes.',
  'workflow.guideStepsTitle': 'Three steps',
  'workflow.guideStepsA': ': ① Type one sentence in "Goal" and click ',
  'workflow.guideStepsB': ' (auto-generates YAML; hand-writing also works) → ② Click ',
  'workflow.guideStepsC': ' to confirm it is valid → ③ Click ',
  'workflow.guideStepsD': " — each node's status and output appear below in real time.",
  'workflow.guideApprovalTitle': 'Node-level approval',
  'workflow.guideApprovalA': ': add ',
  'workflow.guideApprovalB': ' to a node and it will ',
  'workflow.guideApprovalPause': 'pause and wait for your approval',
  'workflow.guideApprovalC': ' before executing (the run shows waiting_human). The Approval Center page gathers every pending approval (including file-edit approvals from Chat mode): you can ',
  'workflow.guideApprovalOps': 'approve / reject / edit the parameter JSON first and then approve',
  'workflow.guideApprovalD': " — the edited parameters become the node's actual input.",
  'workflow.guideResumeTitle': 'Checkpoint resume',
  'workflow.guideResumeA': ': Graph saves a checkpoint after each node completes. If the service restarts midway, a yellow banner at the top lists the interrupted runs — click "Resume" to continue from the breakpoint; ',
  'workflow.guideResumeB': 'completed nodes will not re-run',
  'workflow.guideResumeC': ' — only unfinished ones continue.',
  // Header / interrupted-run banner
  'workflow.subtitle': 'Graph mode — deterministic DAG · node-level approval · checkpoint resume',
  'workflow.resumableDetected': 'Detected {n} graph run(s) interrupted by a service restart (completed nodes will not re-run)',
  'workflow.resume': 'Resume',
  // YAML editor
  'workflow.yamlTitle': 'Graph YAML (draft auto-saved)',
  'workflow.validate': 'Validate',
  'workflow.validateOk': '✓ Validation passed · topological order: {order}',
  'workflow.defaultYaml': `name: my-workflow
description: Example - read a web page and summarize it (replace with your own skill orchestration)
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
  // Run panel
  'workflow.run': 'Run',
  'workflow.goalPlaceholder': 'Goal description (required for AI Compose; optional when running)',
  'workflow.runInputPlaceholder': 'Run input JSON (optional, overrides the graph input defaults), e.g. {"url": "https://..."}',
  'workflow.artifactDir': 'Artifact directory',
  'workflow.wsTemp': 'System temp directory (nothing is saved)',
  'workflow.wsOption': 'Workspace · {name}',
  'workflow.wsHint': 'Documents and other artifacts will be saved to the selected workspace folder (you can open it directly in the file explorer)',
  'workflow.aiCompose': 'AI Compose',
  'workflow.runGraph': 'Run Graph',
  'workflow.cancel': 'Cancel',
  // Running state
  'workflow.nodePreview': 'Node preview: {nodes}',
  'workflow.noNodes': '(no nodes recognized)',
  'workflow.connected': '● Connected',
  'workflow.connecting': '○ Connecting…',
  'workflow.running': 'Running',
  'workflow.runFailedTitle': 'Graph execution failed:',
  'workflow.nodePrefix': 'Node ',
  'workflow.nodeFailedSkill': ' ({skill}): ',
  'workflow.unknownError': 'unknown error',
  'workflow.commonCauses': 'Common causes: a misspelled skill name (check it on the Skills page first), or the skill itself failed (see its error in the node list above).',
  'workflow.resultsTitle': 'Results ({n} node outputs)',
  'workflow.approvalWaiting': ' is waiting for approval — you may edit its parameters and approve (you can also handle it in Approval Center)',
  'workflow.approve': 'Approve and continue',
  'workflow.reject': 'Reject',
  // Error messages (in-page error box)
  'workflow.errGoalRequired': 'Fill in the goal description in the run panel first',
  'workflow.errCompileFailed': 'AI Compose failed: {msg}',
  'workflow.errRunInputJson': 'Run input is not valid JSON',
  'workflow.errCreateFailed': 'Failed to create',
  'workflow.errParamJson': 'Invalid parameter JSON',
};
