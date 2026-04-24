'use strict'

const path = require('path')
const { execSync } = require('child_process')

function getDiff(cwd, filePath) {
  try {
    const fileArg = filePath ? `-- "${filePath}"` : ''
    const diff = execSync(`git diff HEAD ${fileArg}`, { cwd, timeout: 5000 }).toString()
    if (diff) return diff
    return execSync(`git diff --cached ${fileArg}`, { cwd, timeout: 5000 }).toString()
  } catch { return '' }
}

function activate(api) {
  api.registerPanel({
    id: 'diff',
    type: 'diff',
    title: 'Git Diff',
    icon: 'git-branch',
    defaultWidth: 380,
    minWidth: 220,
    maxWidth: 700,
  })

  // 세션 시작 시 현재 전체 diff: 변경사항 있으면 펼치고, 없으면 접어둠
  api.onHook('SessionStart', (event) => {
    const cwd = api.storage.get('lastCwd')
    if (!cwd) return
    const diff = getDiff(cwd, null)
    api.updatePanel('diff', { type: 'diff', filePath: null, cwd, diff }, { open: true, collapse: !diff })
  })

  // 활성 탭 전환 시 해당 세션의 cwd로 diff 갱신
  api.onHook('ActiveSessionChanged', (event) => {
    const cwd = event.cwd
    if (!cwd) return
    api.storage.set('lastCwd', cwd)
    const diff = getDiff(cwd, null)
    api.updatePanel('diff', { type: 'diff', filePath: null, cwd, diff }, { open: true, collapse: !diff })
  })

  // Claude 파일 수정 후: 변경사항 있으면 펼치고, 없으면 접어둠
  api.onHook('PostToolUse', (event) => {
    const tool = event.tool_name
    if (!['Edit', 'Write', 'MultiEdit', 'Bash'].includes(tool)) return

    const filePath = event.tool_input?.file_path || null
    const cwd = filePath ? path.dirname(filePath) : (event.tool_input?.cwd || null)
    if (!cwd) return

    api.storage.set('lastCwd', cwd)

    const diff = getDiff(cwd, filePath)
    api.updatePanel('diff', { type: 'diff', filePath, cwd, diff }, { open: true, collapse: !diff })
  })
}

module.exports = { activate }
