'use strict'

const fs = require('fs')
const path = require('path')

const EXCLUDE = new Set([
  'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out',
  'coverage', '.cache', '.turbo', '.parcel-cache', '__pycache__',
  '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  'vendor', '.DS_Store', 'Thumbs.db',
])

const PANEL_ID = 'explorer'
const MAX_FILE_SIZE = 500 * 1024 // 500KB

function buildTree(dirPath, expandedDirs) {
  function readDir(dir, depth) {
    const nodes = []
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return nodes }

    const filtered = entries
      .filter((e) => !EXCLUDE.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() === b.isDirectory()) return a.name.localeCompare(b.name)
        return a.isDirectory() ? -1 : 1
      })

    for (const e of filtered) {
      const isDir = e.isDirectory()
      const fullPath = path.join(dir, e.name)
      const isExpanded = expandedDirs.has(fullPath)
      const node = { id: fullPath, name: e.name, isDir, isExpanded, depth, children: null }
      if (isDir && isExpanded) node.children = readDir(fullPath, depth + 1)
      nodes.push(node)
    }
    return nodes
  }
  return readDir(dirPath, 0)
}

// ─── Render Function ──────────────────────────────────────────────────────────

const RENDER_FN = /* js */`
function SvgIcon({ d, color, size }) {
  return React.createElement('svg', {
    width: size || 13, height: size || 13, viewBox: '0 0 24 24',
    fill: 'none', stroke: color || 'currentColor',
    strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { flexShrink: 0, display: 'block' },
  }, React.createElement('path', { d }))
}

const ICON_FOLDER        = 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'
const ICON_FOLDER_OPEN   = 'M5 19a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h4a2 2 0 0 1 2 2v1M5 19h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2'
const ICON_FILE          = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'
const ICON_FILE_CODE     = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM10 13l-2 2 2 2M14 13l2 2-2 2'
const ICON_CHEVRON_RIGHT = 'M9 18l6-6-6-6'
const ICON_CHEVRON_DOWN  = 'M6 9l6 6 6-6'
const ICON_REFRESH       = 'M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15'

function fileIcon(name, isDir, isExpanded) {
  const ext = name.split('.').pop().toLowerCase()
  if (isDir) return { d: isExpanded ? ICON_FOLDER_OPEN : ICON_FOLDER, color: '#e8a84a' }
  const CODE = ['ts','tsx','js','jsx','mts','cts','mjs','cjs','css','scss','less','py','rb','go','rs','java','kt','swift','vue','svelte','html','sh','bash','zsh']
  if (CODE.includes(ext)) return { d: ICON_FILE_CODE, color: '#6699cc' }
  if (ext === 'json' || ext === 'jsonc') return { d: ICON_FILE_CODE, color: '#e5c07b' }
  if (['md','mdx','txt'].includes(ext)) return { d: ICON_FILE, color: '#aaaacc' }
  return { d: ICON_FILE, color: '#666688' }
}

function flattenTree(nodes, result) {
  if (!nodes) return
  for (const node of nodes) {
    result.push(node)
    if (node.isDir && node.isExpanded && node.children) flattenTree(node.children, result)
  }
}

return function FileExplorer({ data, onAction }) {
  const projects = data && data.projects ? data.projects : []
  const [activeIdx, setActiveIdx] = useState(0)

  // projects가 바뀌면 activeIdx가 범위를 벗어나지 않도록 보정
  const safeIdx = projects.length === 0 ? 0 : Math.min(activeIdx, projects.length - 1)
  const current = projects[safeIdx] || null
  const flat = []
  if (current) flattenTree(current.tree, flat)

  function handleRefresh() { onAction('refresh', { cwd: current && current.cwd }) }
  function handleNodeClick(node) {
    if (node.isDir) {
      onAction('expand', { id: node.id, cwd: current && current.cwd })
    } else {
      onAction('open_file', { id: node.id, cwd: current && current.cwd })
    }
  }
  function handleDragStart(e, node) {
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('text/plain', '@' + node.id + ' ')
  }

  return React.createElement('div', { style: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' } },

    // ── 탭바 (프로젝트 2개 이상일 때만 표시) ──────────────────────────────
    projects.length > 1 && React.createElement('div', {
      style: {
        display: 'flex', alignItems: 'stretch', flexShrink: 0,
        borderBottom: '1px solid #2a2a3a', overflowX: 'auto',
        msOverflowStyle: 'none',
      }
    },
      projects.map((proj, i) =>
        React.createElement('button', {
          key: proj.cwd,
          onClick: () => setActiveIdx(i),
          title: proj.cwd,
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
        }, proj.cwd.split('/').pop())
      )
    ),

    // ── 헤더 (현재 프로젝트명 + 새로고침) ────────────────────────────────
    React.createElement('div', {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '4px 8px 4px 10px', borderBottom: '1px solid #2a2a3a', flexShrink: 0,
      }
    },
      React.createElement('span', {
        style: { fontSize: '10px', fontWeight: 600, color: '#6666aa', textTransform: 'uppercase', letterSpacing: '0.06em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }
      }, current ? current.cwd.split('/').pop() : 'Explorer'),
      React.createElement('button', {
        onClick: handleRefresh,
        title: '새로고침',
        style: { background: 'none', border: 'none', cursor: 'pointer', color: '#6666aa', display: 'flex', padding: '2px', borderRadius: '3px' },
        onMouseEnter: (e) => { e.currentTarget.style.color = '#9999cc'; e.currentTarget.style.background = '#2a2a3a' },
        onMouseLeave: (e) => { e.currentTarget.style.color = '#6666aa'; e.currentTarget.style.background = 'none' },
      },
        React.createElement(SvgIcon, { d: ICON_REFRESH, size: 12 })
      )
    ),

    // ── 파일 트리 ─────────────────────────────────────────────────────────
    React.createElement('div', {
      style: { flex: 1, overflowY: 'auto', overflowX: 'hidden', fontFamily: "-apple-system, 'Segoe UI', sans-serif", fontSize: '12px' }
    },
      flat.length === 0
        ? React.createElement('div', {
            style: { textAlign: 'center', padding: '16px', color: '#44445a', fontSize: '11px' }
          }, current ? '파일 없음' : '세션을 시작하세요')
        : flat.map((node) => {
            const iconInfo = fileIcon(node.name, node.isDir, node.isExpanded)
            const paddingLeft = 10 + node.depth * 16
            return React.createElement('div', {
              key: node.id,
              draggable: true,
              onClick: () => handleNodeClick(node),
              onDragStart: (e) => handleDragStart(e, node),
              title: node.isDir ? node.name + ' (클릭하여 열기, 드래그하여 터미널 참조)' : node.id + ' (클릭하여 미리보기, 드래그하여 터미널 참조)',
              style: {
                display: 'flex', alignItems: 'center', gap: '5px',
                paddingTop: '2px', paddingBottom: '2px',
                paddingLeft: paddingLeft + 'px', paddingRight: '8px',
                cursor: 'pointer', userSelect: 'none',
              },
              onMouseEnter: (e) => { e.currentTarget.style.background = '#1e1e30' },
              onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
            },
              node.isDir
                ? React.createElement(SvgIcon, { d: node.isExpanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT, color: '#555577', size: 10 })
                : React.createElement('span', { style: { width: 10, flexShrink: 0 } }),
              React.createElement(SvgIcon, { d: iconInfo.d, color: iconInfo.color, size: 13 }),
              React.createElement('span', {
                style: { color: node.isDir ? '#ccccee' : '#aaaacc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }
              }, node.name)
            )
          })
    )
  )
}
`

// ─── activate ─────────────────────────────────────────────────────────────────

function activate(api) {
  // cwd → { expandedDirs: Set }
  const cwdState = new Map()
  let currentCwds = []

  // 패널 1개만 등록 (고정 id)
  api.registerPanel({
    id: PANEL_ID,
    type: 'custom',
    title: 'Explorer',
    icon: 'folder',
    defaultWidth: 280,
    minWidth: 200,
    maxWidth: 600,
    renderFn: RENDER_FN,
  })

  function getOrCreateState(cwd) {
    if (!cwdState.has(cwd)) cwdState.set(cwd, { expandedDirs: new Set() })
    return cwdState.get(cwd)
  }

  function flushPanel() {
    const projects = currentCwds.map((cwd) => {
      const state = getOrCreateState(cwd)
      return { cwd, tree: buildTree(cwd, state.expandedDirs) }
    })
    api.updatePanel(PANEL_ID, { type: 'custom', data: { projects } }, {})
  }

  api.onHook('ActiveSessionChanged', (event) => {
    const cwds = Array.isArray(event.cwds) ? event.cwds : (event.cwd ? [event.cwd] : [])
    if (cwds.length === 0) return

    currentCwds = cwds
    for (const cwd of cwds) getOrCreateState(cwd)

    api.showPanel(PANEL_ID)
    flushPanel()
  })

  api.onHook('PluginAction', (event) => {
    if (event.pluginId !== 'file-explorer-panel') return

    const { action, payload } = event
    const cwd = payload && payload.cwd ? payload.cwd : currentCwds[0]
    if (!cwd) return

    const state = getOrCreateState(cwd)

    if (action === 'refresh') {
      flushPanel()
      return
    }

    const nodeId = payload && payload.id ? payload.id : event.rowId
    if (!nodeId) return

    if (action === 'open_file') {
      try {
        const stat = fs.statSync(nodeId)
        const content = stat.size > MAX_FILE_SIZE ? null : fs.readFileSync(nodeId, 'utf8')
        api.showModal(nodeId, content)
      } catch {
        api.showModal(nodeId, '파일을 읽을 수 없습니다.')
      }
      return
    }

    if (action === 'expand') {
      if (state.expandedDirs.has(nodeId)) {
        const toDelete = []
        for (const p of state.expandedDirs) {
          if (p === nodeId || p.startsWith(nodeId + path.sep)) toDelete.push(p)
        }
        for (const p of toDelete) state.expandedDirs.delete(p)
      } else {
        state.expandedDirs.add(nodeId)
      }
      flushPanel()
    }
  })
}

module.exports = { activate }
