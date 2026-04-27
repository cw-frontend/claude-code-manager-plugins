'use strict'

const path = require('path')
const { execSync } = require('child_process')

/** git repo root 반환. 실패 시 null */
function getGitRoot(cwd) {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd, timeout: 3000 }).toString().trim()
  } catch { return null }
}

/** repo 전체 diff (staged + unstaged + untracked 파일 포함) */
function getRepoDiff(repoRoot) {
  try {
    // untracked 파일을 intent-to-add로 스테이징해서 diff에 잡히게 함 (실제 스테이징 아님)
    execSync('git add -N .', { cwd: repoRoot, timeout: 3000 })
  } catch { /* 무시 */ }
  try {
    return execSync('git diff HEAD', { cwd: repoRoot, timeout: 5000 }).toString()
  } catch { return '' }
}

/** repoRoot → 안전한 패널 id */
function repoToPanelId(repoRoot) {
  return 'diff::' + repoRoot.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** repoRoot → 표시용 짧은 이름 */
function repoToTitle(repoRoot) {
  return 'Git Diff · ' + path.basename(repoRoot)
}

function activate(api) {
  // 등록된 repo root 목록 (패널 id 계산용)
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

  function updateRepoDiff(repoRoot) {
    const panelId = ensurePanel(repoRoot)
    const diff = getRepoDiff(repoRoot)
    api.updatePanel(panelId, { type: 'diff', filePath: null, cwd: repoRoot, diff }, {
      open: true,
    })
  }

  // 활성 탭 전환 시: 현재 세션 레포만 show, 나머지 hide
  api.onHook('ActiveSessionChanged', (event) => {
    const cwds = Array.isArray(event.cwds) ? event.cwds : (event.cwd ? [event.cwd] : [])
    if (cwds.length === 0) return

    // 현재 세션의 repo root 목록
    const activeRepos = new Set()
    for (const cwd of cwds) {
      const repoRoot = getGitRoot(cwd)
      if (repoRoot) activeRepos.add(repoRoot)
    }

    // 등록된 패널 중 현재 세션과 무관한 것은 hide
    for (const repoRoot of registeredRepos) {
      if (!activeRepos.has(repoRoot)) {
        api.hidePanel(repoToPanelId(repoRoot))
      }
    }

    // 현재 세션 레포 diff 갱신 및 show
    for (const repoRoot of activeRepos) {
      updateRepoDiff(repoRoot)
    }
  })

  // 파일 수정 후: 해당 레포 diff만 갱신 (현재 세션 레포임이 보장됨)
  api.onHook('PostToolUse', (event) => {
    const tool = event.tool_name
    if (!['Edit', 'Write', 'MultiEdit', 'Bash'].includes(tool)) return

    const filePath = event.tool_input?.file_path || null
    const rawCwd = filePath ? path.dirname(filePath) : (event.tool_input?.cwd || null)

    if (rawCwd) {
      // cwd를 알 수 있으면 해당 레포만 갱신
      const repoRoot = getGitRoot(rawCwd)
      if (repoRoot) updateRepoDiff(repoRoot)
    } else {
      // Bash처럼 cwd가 없는 경우 — 등록된 모든 레포 갱신
      for (const repoRoot of registeredRepos) {
        updateRepoDiff(repoRoot)
      }
    }
  })
}

module.exports = { activate }
