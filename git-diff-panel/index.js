'use strict'

const path = require('path')
const { execSync } = require('child_process')

/** git repo root 반환. 실패 시 null */
function getGitRoot(cwd) {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd, timeout: 3000 }).toString().trim()
  } catch { return null }
}

/** repo 전체 diff (staged + unstaged 모두) */
function getRepoDiff(repoRoot) {
  try {
    const unstaged = execSync('git diff HEAD', { cwd: repoRoot, timeout: 5000 }).toString()
    if (unstaged) return unstaged
    return execSync('git diff --cached', { cwd: repoRoot, timeout: 5000 }).toString()
  } catch { return '' }
}

/** repoRoot → 안전한 패널 id (슬래시 등 특수문자 제거) */
function repoToPanelId(repoRoot) {
  return 'diff::' + repoRoot.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** repoRoot → 표시용 짧은 이름 */
function repoToTitle(repoRoot) {
  return 'Git Diff · ' + path.basename(repoRoot)
}

function activate(api) {
  // 등록된 repo root 추적
  const registeredRepos = new Set()

  function ensurePanel(repoRoot) {
    const panelId = repoToPanelId(repoRoot)
    if (!registeredRepos.has(repoRoot)) {
      registeredRepos.add(repoRoot)
      api.registerPanel({
        id: panelId,
        type: 'diff',
        title: repoToTitle(repoRoot),
        icon: 'git-branch',
        defaultWidth: 380,
        minWidth: 220,
        maxWidth: 800,
      })
    }
    return panelId
  }

  function updateRepoDiff(repoRoot, opts = {}) {
    const panelId = ensurePanel(repoRoot)
    const diff = getRepoDiff(repoRoot)
    api.updatePanel(panelId, { type: 'diff', filePath: null, cwd: repoRoot, diff }, {
      open: opts.open ?? true,
      collapse: opts.collapse ?? !diff,
    })
  }

  // 활성 탭 전환 시
  api.onHook('ActiveSessionChanged', (event) => {
    const cwd = event.cwd
    if (!cwd) return
    const repoRoot = getGitRoot(cwd)
    if (!repoRoot) return

    // 최근 repo 목록 저장 (최대 10개)
    let lastRepos = api.storage.get('lastRepos')
    if (!Array.isArray(lastRepos)) lastRepos = []
    if (!lastRepos.includes(repoRoot)) {
      lastRepos = [repoRoot, ...lastRepos].slice(0, 10)
      api.storage.set('lastRepos', lastRepos)
    }

    updateRepoDiff(repoRoot)
  })

  // 파일 수정 후
  api.onHook('PostToolUse', (event) => {
    const tool = event.tool_name
    if (!['Edit', 'Write', 'MultiEdit', 'Bash'].includes(tool)) return

    const filePath = event.tool_input?.file_path || null
    const rawCwd = filePath ? path.dirname(filePath) : (event.tool_input?.cwd || null)
    if (!rawCwd) return

    const repoRoot = getGitRoot(rawCwd)
    if (!repoRoot) return

    // 최근 repo 목록 갱신
    let lastRepos = api.storage.get('lastRepos')
    if (!Array.isArray(lastRepos)) lastRepos = []
    if (!lastRepos.includes(repoRoot)) {
      lastRepos = [repoRoot, ...lastRepos].slice(0, 10)
      api.storage.set('lastRepos', lastRepos)
    }

    updateRepoDiff(repoRoot)
  })
}

module.exports = { activate }
