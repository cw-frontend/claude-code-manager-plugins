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

  // 세션 시작 시 현재 전체 diff 표시
  api.onHook('SessionStart', (event) => {
    const cwd = api.storage.get('lastCwd')
    if (!cwd) return
    const diff = getDiff(cwd, null)
    api.updatePanel('diff', { type: 'diff', filePath: null, cwd, diff }, { open: true })
  })

  api.onHook('PostToolUse', (event) => {
    const tool = event.tool_name
    if (!['Edit', 'Write', 'MultiEdit', 'Bash'].includes(tool)) return

    const filePath = event.tool_input?.file_path || null
    const cwd = filePath ? path.dirname(filePath) : (event.tool_input?.cwd || null)
    if (!cwd) return

    // 마지막 cwd 저장 (SessionStart 시 재사용)
    api.storage.set('lastCwd', cwd)

    const diff = getDiff(cwd, filePath)
    api.updatePanel('diff', { type: 'diff', filePath, cwd, diff }, { open: true })
  })
}

module.exports = { activate }
