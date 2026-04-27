'use strict'

const fs = require('fs')
const path = require('path')

const PANEL_ID = 'explorer'

// 기본 제외 목록 (lazy loading이라도 목록 자체는 숨기는 게 U�)
const EXCLUDE = new Set([
  'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out',
  'coverage', '.cache', '.turbo', '.parcel-cache', '__pycache__',
  '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  'vendor', '.DS_Store', 'Thumbs.db',
])

// 파일 이름 → 이모지
function fileIcon(name, isDir) {
  if (isDir) return '📁'
  const ext = path.extname(name).toLowerCase()
  const icons = {
    '.ts': '📘', '.tsx': '📘', '.js': '📙', '.jsx': '📙',
    '.json': '📋', '.md': '📝', '.mdx': '📝',
    '.css': '🎨', '.scss': '🎨', '.less': '🎨',
    '.html': '🌐', '.vue': '💚', '.svelte': '🔥',
    '.py': '🐍', '.rb': '💎', '.go': '🐹', '.rs': '🦀',
    '.java': '☕', '.kt': '🟣', '.swift': '🍎',
    '.sh': '⚙️', '.bash': '⚙️', '.zsh': '⚙️',
    '.yml': '📐', '.yaml': '📐', '.toml': '📐', '.env': '🔐',
    '.png': '🖼️', '.jpg': '🖼️', '.jpeg': '🖼️', '.gif': '🖼️', '.svg': '🖼️',
    '.mp4': '🎬', '.mp3': '🎵',
    '.zip': '📦', '.tar': '📦', '.gz': '📦',
    '.pdf': '📕', '.lock': '🔒',
  }
  return icons[ext] ?? '📄'
}

// 디렉터리 내용을 읽어 rows 배열로 반환
// prefix: 들여쓰기 문자열, parentPath: 절대 경로
function readDir(dirPath, prefix) {
  let entries
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return []
  }

  // 제외 항목 필터링, 숨김파일 제외, 디렉터리 우선 정렬
  const filtered = entries
    .filter((e) => !EXCLUDE.has(e.name) && !e.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() === b.isDirectory()) return a.name.localeCompare(b.name)
      return a.isDirectory() ? -1 : 1
    })

  return filtered.map((e) => {
    const isDir = e.isDirectory()
    const fullPath = path.join(dirPath, e.name)
    return {
      _id: fullPath,
      _title: prefix + fileIcon(e.name, isDir) + ' ' + e.name,
      _badge: isDir ? 'dir' : path.extname(e.name).slice(1) || 'file',
      action: isDir ? 'expand' : 'open',
      // 접힌 상태 추적용 (렌더링엔 안 보임)
      _isDir: isDir ? 'true' : 'false',
      _depth: (prefix.length / 2).toString(),
    }
  })
}

function activate(api) {
  // 세션별 루트 경로 (ActiveSessionChanged 로 갱신)
  let currentRoot = null

  // 현재 패널에 표시 중인 rows (expand/collapse 상태 관리용)
  let currentRows = []

  // 펼쳐진 디렉터리 경로 Set
  const expandedDirs = new Set()

  api.registerPanel({
    id: PANEL_ID,
    type: 'table',
    title: 'File Explorer',
    icon: 'file-text',
    defaultWidth: 280,
    minWidth: 200,
    maxWidth: 600,
  })

  // rows를 패널에 반영
  function flush(open) {
    api.updatePanel(PANEL_ID, {
      type: 'table',
      columns: [
        { key: '_title', label: 'Name' },
        { key: '_badge', label: '', width: 48, align: 'right' },
      ],
      rows: currentRows,
      listMode: true,
      status: currentRoot ? path.basename(currentRoot) : '',
    }, open ? { open: true } : {})
  }

  // 루트부터 전체 rows 재구성 (expandedDirs 상태 반영)
  function rebuildRows(root) {
    currentRows = buildRows(root, '', 0)
  }

  // 재귀적으로 rows 빌드 (expandedDirs에 있는 디렉터리는 자식 포함)
  function buildRows(dirPath, prefix, depth) {
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
      const indent = '  '.repeat(depth)
      const expandMark = isDir ? (isExpanded ? '▾ ' : '▸ ') : '  '

      rows.push({
        _id: fullPath,
        _title: indent + expandMark + fileIcon(e.name, isDir) + ' ' + e.name,
        _badge: isDir ? (isExpanded ? 'open' : 'dir') : (path.extname(e.name).slice(1) || 'file'),
        action: isDir ? 'expand' : 'open',
        _isDir: isDir ? 'true' : 'false',
        _depth: depth.toString(),
      })

      // 펼쳐진 디렉터리면 자식 재귀 삽입
      if (isDir && isExpanded) {
        rows.push(...buildRows(fullPath, prefix + '  ', depth + 1))
      }
    }
    return rows
  }

  // 세션 전환 시 루트 갱신
  api.onHook('ActiveSessionChanged', (event) => {
    const cwds = Array.isArray(event.cwds) ? event.cwds : (event.cwd ? [event.cwd] : [])
    if (cwds.length === 0) return

    const root = cwds[0]
    if (root === currentRoot) return

    currentRoot = root
    expandedDirs.clear()
    rebuildRows(root)
    flush(true)
  })

  // Claude가 파일을 읽거나 수정하면 트리 갱신 (구조 변경 반영)
  api.onHook('PostToolUse', (event) => {
    if (!currentRoot) return
    const tool = event.tool_name
    if (!['Read', 'Write', 'Edit', 'MultiEdit', 'Bash'].includes(tool)) return

    // 파일 생성/삭제가 있을 수 있으므로 rows 재빌드
    rebuildRows(currentRoot)
    flush(false)
  })

  // 행 클릭 이벤트 (PluginAction 훅)
  api.onHook('PluginAction', (event) => {
    if (event.pluginId !== 'file-explorer-panel') return
    if (event.panelId !== PANEL_ID) return

    const fullPath = event.rowId
    if (!fullPath) return

    if (event.action === 'expand') {
      // 토글: 펼쳐져 있으면 접기, 아니면 펼치기
      if (expandedDirs.has(fullPath)) {
        // 이 경로와 하위 경로 모두 제거
        for (const p of expandedDirs) {
          if (p === fullPath || p.startsWith(fullPath + path.sep)) {
            expandedDirs.delete(p)
          }
        }
      } else {
        expandedDirs.add(fullPath)
      }
      rebuildRows(currentRoot)
      flush(false)
    } else if (event.action === 'open') {
      // 파일은 알림만 (향후 에디터 연동 등 확장 가능)
      api.notify(path.relative(currentRoot, fullPath), 'info')
    }
  })
}

module.exports = { activate }
