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

// ─── Render Function (renderer 프로세스에서 new Function()으로 실행) ──────────

const RENDER_FN = /* js */`
// ── 유틸 ────────────────────────────────────────────────────────────────────
function parseDiffLines(diff) {
  const lines = diff.split('\\n')
  const items = []
  let lineNoOld = 0, lineNoNew = 0, fileCount = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('diff --git')) {
      const m = line.match(/b\\/(.+)$/)
      items.push({ kind: 'file', key: i, name: m ? m[1] : line, first: fileCount === 0 })
      fileCount++
      continue
    }
    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/)
      if (m) { lineNoOld = parseInt(m[1]) - 1; lineNoNew = parseInt(m[2]) - 1 }
      items.push({ kind: 'hunk', key: i, text: line })
      continue
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('\\\\') ||
        line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
      continue
    }
    if (line.startsWith('+')) { lineNoNew++; items.push({ kind: 'add', key: i, lineNo: lineNoNew, text: line.slice(1) }); continue }
    if (line.startsWith('-')) { lineNoOld++; items.push({ kind: 'del', key: i, lineNo: lineNoOld, text: line.slice(1) }); continue }
    lineNoOld++; lineNoNew++
    items.push({ kind: 'ctx', key: i, lineNo: lineNoNew, text: line.slice(1) })
  }
  return items
}

// ── 메인 컴포넌트 ────────────────────────────────────────────────────────────
return function GitDiffPanel({ data, onAction }) {
  const diff = data && data.diff != null ? data.diff : ''
  const cwd = data && data.cwd ? data.cwd : ''
  const repoLabel = cwd ? cwd.split('/').pop() : ''

  let addCount = 0, delCount = 0
  for (const line of diff.split('\\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) addCount++
    else if (line.startsWith('-') && !line.startsWith('---')) delCount++
  }

  const items = diff ? parseDiffLines(diff) : []

  const headerStyle = {
    display: 'flex', alignItems: 'center', gap: '6px',
    padding: '4px 10px', borderBottom: '1px solid #1e1e2e', flexShrink: 0,
  }
  const centerStyle = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: '80px', color: '#44445a', fontSize: '12px',
  }

  return React.createElement('div', { style: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' } },
    // 헤더
    React.createElement('div', { style: headerStyle },
      repoLabel && React.createElement('span', {
        style: { fontSize: '10px', color: '#555577', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }
      }, repoLabel),
      diff && React.createElement('div', { style: { display: 'flex', gap: '6px', flexShrink: 0, fontSize: '10px' } },
        React.createElement('span', { style: { color: '#4ec994' } }, '+' + addCount),
        React.createElement('span', { style: { color: '#e06c75' } }, '-' + delCount)
      ),
      React.createElement('button', {
        onClick: () => onAction('refresh'),
        title: '새로고침',
        style: { background: 'none', border: 'none', cursor: 'pointer', color: '#6666aa', display: 'flex', padding: '2px' },
        onMouseEnter: (e) => { e.currentTarget.style.color = '#9999cc' },
        onMouseLeave: (e) => { e.currentTarget.style.color = '#6666aa' },
      },
        React.createElement('svg', {
          width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        }, React.createElement('path', { d: 'M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15' }))
      )
    ),
    // diff 내용
    React.createElement('div', {
      style: { flex: 1, overflowY: 'auto', overflowX: 'hidden', fontFamily: "'SF Mono', Menlo, monospace", fontSize: '11px' }
    },
      items.length === 0
        ? React.createElement('div', { style: centerStyle }, '변경사항 없음')
        : items.map((item) => {
            if (item.kind === 'file') {
              return React.createElement('div', {
                key: item.key,
                style: { padding: '6px 10px', background: '#1e1e30', color: '#aaaacc', borderTop: !item.first ? '1px solid #2a2a3a' : 'none', marginTop: !item.first ? '4px' : 0 }
              }, item.name)
            }
            if (item.kind === 'hunk') {
              return React.createElement('div', {
                key: item.key,
                style: { padding: '2px 10px', background: '#1a1a2e', color: '#7777aa', fontSize: '10px' }
              }, item.text)
            }
            if (item.kind === 'add') {
              return React.createElement('div', { key: item.key, style: { display: 'flex', background: 'rgba(78,201,148,0.12)', lineHeight: '1.6' } },
                React.createElement('span', { style: { minWidth: '32px', color: '#666688', paddingLeft: '6px', flexShrink: 0, userSelect: 'none' } }, item.lineNo),
                React.createElement('span', { style: { minWidth: '14px', color: '#4ec994', flexShrink: 0 } }, '+'),
                React.createElement('span', { style: { color: '#7ddcb0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, item.text)
              )
            }
            if (item.kind === 'del') {
              return React.createElement('div', { key: item.key, style: { display: 'flex', background: 'rgba(224,108,117,0.12)', lineHeight: '1.6' } },
                React.createElement('span', { style: { minWidth: '32px', color: '#666688', paddingLeft: '6px', flexShrink: 0, userSelect: 'none' } }, item.lineNo),
                React.createElement('span', { style: { minWidth: '14px', color: '#e06c75', flexShrink: 0 } }, '-'),
                React.createElement('span', { style: { color: '#e88a93', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, item.text)
              )
            }
            return React.createElement('div', { key: item.key, style: { display: 'flex', lineHeight: '1.6' } },
              React.createElement('span', { style: { minWidth: '32px', color: '#666688', paddingLeft: '6px', flexShrink: 0, userSelect: 'none' } }, item.lineNo),
              React.createElement('span', { style: { minWidth: '14px', flexShrink: 0 } }, ' '),
              React.createElement('span', { style: { color: '#9999bb', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, item.text)
            )
          })
    )
  )
}
`

function activate(api) {
  // 등록된 repo root 목록 (패널 id 계산용)
  const registeredRepos = new Set()

  function ensurePanel(repoRoot) {
    const panelId = repoToPanelId(repoRoot)
    if (!registeredRepos.has(repoRoot)) {
      registeredRepos.add(repoRoot)
      api.registerPanel({
        id: panelId,
        type: 'custom',
        title: repoToTitle(repoRoot),
        icon: 'git-branch',
        defaultWidth: 380,
        minWidth: 220,
        maxWidth: 800,
        renderFn: RENDER_FN,
      })
    }
    return panelId
  }

  function updateRepoDiff(repoRoot) {
    const panelId = ensurePanel(repoRoot)
    const diff = getRepoDiff(repoRoot)
    api.updatePanel(panelId, { type: 'custom', data: { diff, cwd: repoRoot } }, { open: true })
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

  // PluginAction: refresh 버튼 처리
  api.onHook('PluginAction', (event) => {
    if (event.pluginId !== 'git-diff-panel') return
    if (event.action !== 'refresh') return

    const repoRoot = Array.from(registeredRepos).find(
      (r) => repoToPanelId(r) === event.panelId
    )
    if (repoRoot) updateRepoDiff(repoRoot)
  })
}

module.exports = { activate }
