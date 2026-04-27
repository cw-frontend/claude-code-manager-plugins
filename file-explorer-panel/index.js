'use strict'

const fs = require('fs')
const path = require('path')

const EXCLUDE = new Set([
  'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out',
  'coverage', '.cache', '.turbo', '.parcel-cache', '__pycache__',
  '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  'vendor', '.DS_Store', 'Thumbs.db',
])

/** cwd → 패널 id */
function cwdToPanelId(cwd) {
  return 'explorer::' + cwd.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** cwd → 패널 타이틀 */
function cwdToTitle(cwd) {
  return path.basename(cwd)
}

function buildTree(dirPath, expandedDirs) {
  function readDir(dirPath, depth) {
    const nodes = []
    let entries
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true })
    } catch {
      return nodes
    }

    const filtered = entries
      .filter((e) => !EXCLUDE.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() === b.isDirectory()) return a.name.localeCompare(b.name)
        return a.isDirectory() ? -1 : 1
      })

    for (const e of filtered) {
      const isDir = e.isDirectory()
      const fullPath = path.join(dirPath, e.name)
      const isExpanded = expandedDirs.has(fullPath)
      const node = { id: fullPath, name: e.name, isDir, isExpanded, depth, children: null }
      if (isDir && isExpanded) {
        node.children = readDir(fullPath, depth + 1)
      }
      nodes.push(node)
    }
    return nodes
  }
  return readDir(dirPath, 0)
}

/** renderFn: new Function('React','useState','useEffect','useRef','useMemo', body) → returns (data, onAction) => JSX */
const RENDER_FN = /* js */`
// ── 아이콘 SVG (inline) ────────────────────────────────────────────────────
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

// ── 노드 평탄화 ────────────────────────────────────────────────────────────
function flattenTree(nodes, result) {
  if (!nodes) return
  for (const node of nodes) {
    result.push(node)
    if (node.isDir && node.isExpanded && node.children) {
      flattenTree(node.children, result)
    }
  }
}

// ── 메인 컴포넌트 ──────────────────────────────────────────────────────────
return function FileExplorer({ data, onAction }) {
  const tree = data && data.tree ? data.tree : []
  const cwd = data && data.cwd ? data.cwd : ''
  const flat = []
  flattenTree(tree, flat)

  const containerStyle = {
    flex: 1, overflowY: 'auto', overflowX: 'hidden',
    fontFamily: "-apple-system, 'Segoe UI', sans-serif",
    fontSize: '12px',
  }

  const headerStyle = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '4px 8px 4px 10px',
    borderBottom: '1px solid #2a2a3a',
    flexShrink: 0,
  }

  const cwdLabel = cwd ? cwd.split('/').pop() : ''

  function handleRefresh() { onAction('refresh') }
  function handleNodeClick(node) {
    onAction(node.isDir ? 'expand' : 'open', { id: node.id })
  }
  function handleDragStart(e, node) {
    if (node.isDir) { e.preventDefault(); return }
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('text/plain', '@' + node.id + ' ')
  }

  return React.createElement('div', { style: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' } },
    // 헤더
    React.createElement('div', { style: headerStyle },
      React.createElement('span', {
        style: { fontSize: '10px', fontWeight: 600, color: '#6666aa', textTransform: 'uppercase', letterSpacing: '0.06em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }
      }, cwdLabel || 'Explorer'),
      React.createElement('button', {
        onClick: handleRefresh,
        title: '새로고침',
        style: {
          background: 'none', border: 'none', cursor: 'pointer',
          color: '#6666aa', display: 'flex', padding: '2px', borderRadius: '3px',
        },
        onMouseEnter: (e) => { e.currentTarget.style.color = '#9999cc'; e.currentTarget.style.background = '#2a2a3a' },
        onMouseLeave: (e) => { e.currentTarget.style.color = '#6666aa'; e.currentTarget.style.background = 'none' },
      },
        React.createElement(SvgIcon, { d: ICON_REFRESH, size: 12 })
      )
    ),
    // 트리
    React.createElement('div', { style: containerStyle },
      flat.length === 0
        ? React.createElement('div', {
            style: { textAlign: 'center', padding: '16px', color: '#44445a', fontSize: '11px' }
          }, cwd ? '파일 없음' : '세션을 시작하세요')
        : flat.map((node) => {
            const iconInfo = fileIcon(node.name, node.isDir, node.isExpanded)
            const paddingLeft = 10 + node.depth * 16
            return React.createElement('div', {
              key: node.id,
              draggable: !node.isDir,
              onClick: () => handleNodeClick(node),
              onDragStart: (e) => handleDragStart(e, node),
              title: node.isDir ? node.name : node.id + ' (터미널에 드래그하여 참조)',
              style: {
                display: 'flex', alignItems: 'center', gap: '5px',
                paddingTop: '2px', paddingBottom: '2px',
                paddingLeft: paddingLeft + 'px', paddingRight: '8px',
                cursor: node.isDir ? 'pointer' : 'grab', userSelect: 'none',
              },
              onMouseEnter: (e) => { e.currentTarget.style.background = '#1e1e30' },
              onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
            },
              // 폴더 chevron (파일은 빈 공간)
              node.isDir
                ? React.createElement(SvgIcon, {
                    d: node.isExpanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT,
                    color: '#555577', size: 10,
                  })
                : React.createElement('span', { style: { width: 10, flexShrink: 0 } }),
              // 파일/폴더 아이콘
              React.createElement(SvgIcon, { d: iconInfo.d, color: iconInfo.color, size: 13 }),
              // 이름
              React.createElement('span', {
                style: {
                  color: node.isDir ? '#ccccee' : '#aaaacc',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                }
              }, node.name)
            )
          })
    )
  )
}
`

function activate(api) {
  const registeredCwds = new Set()
  const cwdState = new Map() // cwd → { expandedDirs: Set }

  function ensurePanel(cwd) {
    const panelId = cwdToPanelId(cwd)
    if (!registeredCwds.has(cwd)) {
      registeredCwds.add(cwd)
      cwdState.set(cwd, { expandedDirs: new Set() })
      api.registerPanel({
        id: panelId,
        type: 'custom',
        title: cwdToTitle(cwd),
        icon: 'folder',
        defaultWidth: 280,
        minWidth: 200,
        maxWidth: 600,
        renderFn: RENDER_FN,
      })
    }
    return panelId
  }

  function flushPanel(cwd) {
    const panelId = cwdToPanelId(cwd)
    const state = cwdState.get(cwd)
    if (!state) return
    const tree = buildTree(cwd, state.expandedDirs)
    api.updatePanel(panelId, { type: 'custom', data: { tree, cwd } }, {})
  }

  api.onHook('ActiveSessionChanged', (event) => {
    const cwds = Array.isArray(event.cwds) ? event.cwds : (event.cwd ? [event.cwd] : [])
    if (cwds.length === 0) return

    const activeCwds = new Set(cwds)

    for (const cwd of registeredCwds) {
      if (!activeCwds.has(cwd)) {
        api.hidePanel(cwdToPanelId(cwd))
      }
    }

    for (const cwd of cwds) {
      ensurePanel(cwd)
      api.showPanel(cwdToPanelId(cwd))
      flushPanel(cwd)
    }
  })

  api.onHook('PluginAction', (event) => {
    if (event.pluginId !== 'file-explorer-panel') return

    const cwd = Array.from(registeredCwds).find(
      (c) => cwdToPanelId(c) === event.panelId
    )
    if (!cwd) return

    const state = cwdState.get(cwd)
    if (!state) return

    if (event.action === 'refresh') {
      flushPanel(cwd)
      return
    }

    const nodeId = event.payload && event.payload.id ? event.payload.id : event.rowId
    if (!nodeId) return

    if (event.action === 'expand') {
      if (state.expandedDirs.has(nodeId)) {
        const toDelete = []
        for (const p of state.expandedDirs) {
          if (p === nodeId || p.startsWith(nodeId + path.sep)) toDelete.push(p)
        }
        for (const p of toDelete) state.expandedDirs.delete(p)
      } else {
        state.expandedDirs.add(nodeId)
      }
      flushPanel(cwd)
    } else if (event.action === 'open') {
      api.ptyWrite(`@${nodeId} `)
    }
  })
}

module.exports = { activate }
