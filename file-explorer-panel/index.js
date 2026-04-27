'use strict'

const fs = require('fs')
const path = require('path')

const EXCLUDE = new Set([
  'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out',
  'coverage', '.cache', '.turbo', '.parcel-cache', '__pycache__',
  '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  'vendor', '.DS_Store', 'Thumbs.db',
])

function fileIconName(name, isDir, isExpanded) {
  if (isDir) return isExpanded ? 'folder-open' : 'folder'
  const ext = path.extname(name).toLowerCase()
  const icons = {
    '.ts': 'file-code', '.tsx': 'file-code', '.js': 'file-code', '.jsx': 'file-code',
    '.mts': 'file-code', '.cts': 'file-code', '.mjs': 'file-code', '.cjs': 'file-code',
    '.json': 'file-json', '.jsonc': 'file-json',
    '.md': 'file-type', '.mdx': 'file-type', '.txt': 'file-type',
    '.css': 'file-code', '.scss': 'file-code', '.less': 'file-code',
    '.html': 'globe', '.vue': 'file-code', '.svelte': 'file-code',
    '.py': 'file-code', '.rb': 'file-code', '.go': 'file-code', '.rs': 'file-code',
    '.java': 'file-code', '.kt': 'file-code', '.swift': 'file-code',
    '.sh': 'terminal', '.bash': 'terminal', '.zsh': 'terminal',
    '.yml': 'settings', '.yaml': 'settings', '.toml': 'settings', '.env': 'settings',
    '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
    '.svg': 'image', '.webp': 'image', '.ico': 'image',
    '.zip': 'package', '.tar': 'package', '.gz': 'package',
    '.lock': 'settings',
  }
  return icons[ext] ?? 'file'
}

/** cwd → 패널 id */
function cwdToPanelId(cwd) {
  return 'explorer::' + cwd.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** cwd → 패널 타이틀 */
function cwdToTitle(cwd) {
  return path.basename(cwd)
}

function activate(api) {
  // 등록된 cwd Set
  const registeredCwds = new Set()

  // cwd별 상태: { rows, expandedDirs }
  const cwdState = new Map()

  function ensurePanel(cwd) {
    const panelId = cwdToPanelId(cwd)
    if (!registeredCwds.has(cwd)) {
      registeredCwds.add(cwd)
      cwdState.set(cwd, { expandedDirs: new Set() })
      api.registerPanel({
        id: panelId,
        type: 'table',
        title: cwdToTitle(cwd),
        icon: 'folder',
        defaultWidth: 280,
        minWidth: 200,
        maxWidth: 600,
      })
    }
    return panelId
  }

  function buildRows(dirPath, depth, expandedDirs) {
    const rows = []
    let entries
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true })
    } catch {
      return rows
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
      const expandMark = isDir ? (isExpanded ? '▾ ' : '▸ ') : ''

      rows.push({
        _id: fullPath,
        _title: expandMark + e.name,
        _icon: fileIconName(e.name, isDir, isExpanded),
        action: isDir ? 'expand' : 'open',
        _depth: depth.toString(),
      })

      if (isDir && isExpanded) {
        rows.push(...buildRows(fullPath, depth + 1, expandedDirs))
      }
    }
    return rows
  }

  function flushPanel(cwd) {
    const panelId = cwdToPanelId(cwd)
    const state = cwdState.get(cwd)
    if (!state) return
    const rows = buildRows(cwd, 0, state.expandedDirs)
    // 새로고침 액션 행을 맨 위에 추가
    const refreshRow = {
      _id: '__refresh__',
      _title: '새로고침',
      _icon: 'refresh',
      action: 'refresh',
      _depth: '0',
    }
    api.updatePanel(panelId, {
      type: 'table',
      columns: [{ key: '_title', label: 'Name' }],
      rows: [refreshRow, ...rows],
      listMode: true,
      status: cwdToTitle(cwd),
    }, {})
  }

  // 세션 전환: 현재 세션 cwd 패널만 show, 나머지 hide
  api.onHook('ActiveSessionChanged', (event) => {
    const cwds = Array.isArray(event.cwds) ? event.cwds : (event.cwd ? [event.cwd] : [])
    if (cwds.length === 0) return

    const activeCwds = new Set(cwds)

    // 비활성 패널 hide
    for (const cwd of registeredCwds) {
      if (!activeCwds.has(cwd)) {
        api.hidePanel(cwdToPanelId(cwd))
      }
    }

    // 활성 cwd 패널 갱신 및 show
    for (const cwd of cwds) {
      ensurePanel(cwd)
      api.showPanel(cwdToPanelId(cwd))
      flushPanel(cwd)
    }
  })

  // 행 클릭 (PluginAction)
  api.onHook('PluginAction', (event) => {
    if (event.pluginId !== 'file-explorer-panel') return

    // event.panelId는 local id (예: "explorer::_Users_foo_project")
    const cwd = Array.from(registeredCwds).find(
      (c) => cwdToPanelId(c) === event.panelId
    )
    if (!cwd) return

    const state = cwdState.get(cwd)
    if (!state) return

    const fullPath = event.rowId
    if (!fullPath) return

    if (event.action === 'refresh') {
      flushPanel(cwd)
      return
    }

    if (event.action === 'expand') {
      if (state.expandedDirs.has(fullPath)) {
        for (const p of state.expandedDirs) {
          if (p === fullPath || p.startsWith(fullPath + path.sep)) {
            state.expandedDirs.delete(p)
          }
        }
      } else {
        state.expandedDirs.add(fullPath)
      }
      flushPanel(cwd)
    } else if (event.action === 'open') {
      // 파일 경로를 pty에 @참조로 전송
      api.ptyWrite(`@${fullPath} `)
    }
  })
}

module.exports = { activate }
