'use strict'

const path = require('path')
const { execSync } = require('child_process')

const PANEL_ID = 'git-diff'

/** git repo root 반환. 실패 시 null */
function getGitRoot(cwd) {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd, timeout: 3000 }).toString().trim()
  } catch { return null }
}

/** repo 전체 diff (staged + unstaged + untracked 파일 포함) */
function getRepoDiff(repoRoot) {
  try {
    execSync('git add -N .', { cwd: repoRoot, timeout: 3000 })
  } catch { /* 무시 */ }
  try {
    return execSync('git diff HEAD', { cwd: repoRoot, timeout: 5000 }).toString()
  } catch { return '' }
}

// ─── Render Function ──────────────────────────────────────────────────────────

const RENDER_FN = /* js */`
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

const ICON_REFRESH = 'M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15'

function SvgIcon({ d, size }) {
  return React.createElement('svg', {
    width: size || 11, height: size || 11, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor',
    strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { flexShrink: 0, display: 'block' },
  }, React.createElement('path', { d }))
}

return function GitDiffPanel({ data, onAction }) {
  const repos = data && data.repos ? data.repos : []
  const [activeIdx, setActiveIdx] = useState(0)

  const safeIdx = repos.length === 0 ? 0 : Math.min(activeIdx, repos.length - 1)
  const current = repos[safeIdx] || null
  const diff = current ? current.diff : ''
  const repoRoot = current ? current.repoRoot : ''

  let addCount = 0, delCount = 0
  for (const line of diff.split('\\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) addCount++
    else if (line.startsWith('-') && !line.startsWith('---')) delCount++
  }

  const items = diff ? parseDiffLines(diff) : []

  const centerStyle = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: '80px', color: '#44445a', fontSize: '12px',
  }

  return React.createElement('div', { style: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' } },

    // ── 탭바 (repo 2개 이상일 때만) ────────────────────────────────────────
    repos.length > 1 && React.createElement('div', {
      style: {
        display: 'flex', alignItems: 'stretch', flexShrink: 0,
        borderBottom: '1px solid #2a2a3a', overflowX: 'auto',
      }
    },
      repos.map((repo, i) =>
        React.createElement('button', {
          key: repo.repoRoot,
          onClick: () => setActiveIdx(i),
          title: repo.repoRoot,
          style: {
            padding: '4px 10px', border: 'none', cursor: 'pointer',
            fontSize: '11px', fontWeight: safeIdx === i ? 600 : 400,
            color: safeIdx === i ? '#ccccee' : '#555577',
            background: safeIdx === i ? '#1e1e30' : 'transparent',
            borderBottom: safeIdx === i ? '2px solid #8251EE' : '2px solid transparent',
            whiteSpace: 'nowrap', flexShrink: 0,
            transition: 'color 120ms, background 120ms',
          },
          onMouseEnter: (e) => { if (safeIdx !== i) e.currentTarget.style.color = '#9999cc' },
          onMouseLeave: (e) => { if (safeIdx !== i) e.currentTarget.style.color = '#555577' },
        }, repo.repoRoot.split('/').pop())
      )
    ),

    // ── 헤더 (repo명 + stats + refresh) ───────────────────────────────────
    React.createElement('div', {
      style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 10px', borderBottom: '1px solid #1e1e2e', flexShrink: 0 }
    },
      repoRoot && React.createElement('span', {
        style: { fontSize: '10px', color: '#555577', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }
      }, repoRoot.split('/').pop()),
      diff && React.createElement('div', { style: { display: 'flex', gap: '6px', flexShrink: 0, fontSize: '10px' } },
        React.createElement('span', { style: { color: '#4ec994' } }, '+' + addCount),
        React.createElement('span', { style: { color: '#e06c75' } }, '-' + delCount)
      ),
      React.createElement('button', {
        onClick: () => onAction('refresh', { repoRoot }),
        title: '새로고침',
        style: { background: 'none', border: 'none', cursor: 'pointer', color: '#6666aa', display: 'flex', padding: '2px' },
        onMouseEnter: (e) => { e.currentTarget.style.color = '#9999cc' },
        onMouseLeave: (e) => { e.currentTarget.style.color = '#6666aa' },
      },
        React.createElement(SvgIcon, { d: ICON_REFRESH, size: 11 })
      )
    ),

    // ── diff 내용 ──────────────────────────────────────────────────────────
    React.createElement('div', {
      style: { flex: 1, overflowY: 'auto', overflowX: 'hidden', fontFamily: "'SF Mono', Menlo, monospace", fontSize: '11px' }
    },
      repos.length === 0
        ? React.createElement('div', { style: centerStyle }, '세션을 시작하세요')
        : items.length === 0
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

// ─── activate ─────────────────────────────────────────────────────────────────

function activate(api) {
  // repoRoot → diff 캐시
  const repoDiffs = new Map()
  let currentRepos = [] // 현재 활성 세션의 repo root 목록

  api.registerPanel({
    id: PANEL_ID,
    type: 'custom',
    title: 'Git Diff',
    icon: 'git-branch',
    defaultWidth: 380,
    minWidth: 220,
    maxWidth: 800,
    renderFn: RENDER_FN,
  })

  function flushPanel() {
    const repos = currentRepos.map((repoRoot) => ({
      repoRoot,
      diff: repoDiffs.get(repoRoot) ?? '',
    }))
    api.updatePanel(PANEL_ID, { type: 'custom', data: { repos } }, { open: true })
  }

  function updateRepo(repoRoot) {
    const diff = getRepoDiff(repoRoot)
    repoDiffs.set(repoRoot, diff)
  }

  api.onHook('ActiveSessionChanged', (event) => {
    const cwds = Array.isArray(event.cwds) ? event.cwds : (event.cwd ? [event.cwd] : [])
    if (cwds.length === 0) return

    const activeRepos = []
    for (const cwd of cwds) {
      const repoRoot = getGitRoot(cwd)
      if (repoRoot && !activeRepos.includes(repoRoot)) activeRepos.push(repoRoot)
    }
    if (activeRepos.length === 0) return

    currentRepos = activeRepos
    for (const repoRoot of activeRepos) updateRepo(repoRoot)
    flushPanel()
  })

  api.onHook('PostToolUse', (event) => {
    const tool = event.tool_name
    if (!['Edit', 'Write', 'MultiEdit', 'Bash'].includes(tool)) return

    const filePath = event.tool_input?.file_path || null
    const rawCwd = filePath ? path.dirname(filePath) : (event.tool_input?.cwd || null)

    if (rawCwd) {
      const repoRoot = getGitRoot(rawCwd)
      if (repoRoot && currentRepos.includes(repoRoot)) {
        updateRepo(repoRoot)
        flushPanel()
      }
    } else {
      // cwd 불명 → 현재 활성 repo 전체 갱신
      for (const repoRoot of currentRepos) updateRepo(repoRoot)
      flushPanel()
    }
  })

  api.onHook('PluginAction', (event) => {
    if (event.pluginId !== 'git-diff-panel') return
    if (event.action !== 'refresh') return

    const repoRoot = event.payload && event.payload.repoRoot ? event.payload.repoRoot : null
    if (repoRoot) {
      updateRepo(repoRoot)
    } else {
      for (const r of currentRepos) updateRepo(r)
    }
    flushPanel()
  })
}

module.exports = { activate }
