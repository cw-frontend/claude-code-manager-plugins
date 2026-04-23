'use strict'

const path = require('path')
const { execSync } = require('child_process')

function activate(api) {
  // diff 패널 등록
  api.registerPanel({
    id: 'diff',
    type: 'diff',
    title: 'Git Diff',
    icon: 'git-branch',
    defaultWidth: 380,
    minWidth: 220,
    maxWidth: 700,
  })

  api.onHook('PostToolUse', (event) => {
    const tool = event.tool_name
    if (!['Edit', 'Write', 'MultiEdit', 'Bash'].includes(tool)) return

    const filePath = event.tool_input?.file_path || null
    const cwd = filePath ? path.dirname(filePath) : (event.tool_input?.cwd || null)

    // diff를 직접 계산해서 패널에 전달
    let diff = ''
    try {
      if (cwd) {
        const fileArg = filePath ? `-- "${filePath}"` : ''
        diff = execSync(`git diff HEAD ${fileArg}`, { cwd, timeout: 5000 }).toString()
        if (!diff) {
          diff = execSync(`git diff --cached ${fileArg}`, { cwd, timeout: 5000 }).toString()
        }
      }
    } catch { /* ignore */ }

    api.updatePanel('diff', { type: 'diff', filePath, cwd, diff }, { open: true })
  })
}

module.exports = { activate }
