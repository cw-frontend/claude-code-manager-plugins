'use strict'

const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const GDRIVE_TMP_DIR = '/tmp/claude-gdrive'

// ─── OAuth2 설정 ──────────────────────────────────────────────────────────────

const REDIRECT_PORT = 9234
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`
const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ')

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DRIVE_API = 'https://www.googleapis.com/drive/v3'

// ─── HTTP 유틸 ────────────────────────────────────────────────────────────────

function httpsRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }
    const req = https.request(reqOptions, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// ─── Token 관리 ───────────────────────────────────────────────────────────────

async function refreshAccessToken(storage, clientId, clientSecret) {
  const refreshToken = storage.get('refresh_token')
  if (!refreshToken) return null

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString()

  const res = await httpsRequest(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body)

  if (res.status === 200 && res.body.access_token) {
    const expiresAt = Date.now() + (res.body.expires_in - 60) * 1000
    storage.set('access_token', res.body.access_token)
    storage.set('expires_at', expiresAt)
    return res.body.access_token
  }
  return null
}

async function getValidToken(storage, clientId, clientSecret) {
  const expiresAt = storage.get('expires_at') || 0
  if (Date.now() < expiresAt) return storage.get('access_token')
  return refreshAccessToken(storage, clientId, clientSecret)
}

// ─── Google Drive API ────────────────────────────────────────────────────────

async function searchFiles(token, query) {
  let q
  if (!query) {
    q = 'trashed=false'
  } else {
    const tokens = query.split(/[\s_]+/).filter(Boolean)
    const nameConds = tokens.map((t) => `name contains '${t.replace(/'/g, "\\'")}'`).join(' and ')
    q = `${nameConds} and trashed=false`
  }
  const fields = 'files(id,name,mimeType,modifiedTime,webViewLink,size)'
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=30&orderBy=modifiedTime desc&supportsAllDrives=true&includeItemsFromAllDrives=true`

  const res = await httpsRequest(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status !== 200) throw new Error(`Drive API 오류: ${res.status}`)
  return res.body.files || []
}

async function downloadFile(token, fileId, mimeType, fileName) {
  let url
  if (mimeType === 'application/vnd.google-apps.document') {
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=application/vnd.openxmlformats-officedocument.wordprocessingml.document`
  } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
  } else if (mimeType === 'application/vnd.google-apps.presentation') {
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=application/vnd.openxmlformats-officedocument.presentationml.presentation`
  } else {
    url = `${DRIVE_API}/files/${fileId}?alt=media`
  }

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 303) {
        const loc = res.headers.location
        https.get(loc, (r2) => {
          const chunks = []
          r2.on('data', (c) => chunks.push(c))
          r2.on('end', () => resolve(Buffer.concat(chunks)))
        }).on('error', reject)
        return
      }
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    req.on('error', reject)
    req.end()
  })
}

async function exportAsText(token, fileId, mimeType) {
  let url
  if (mimeType === 'application/vnd.google-apps.document') {
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=text/plain`
  } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=text/csv`
  } else if (mimeType === 'application/vnd.google-apps.presentation') {
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=text/plain`
  } else if ([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  ].includes(mimeType)) {
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=text/plain`
  } else {
    url = `${DRIVE_API}/files/${fileId}?alt=media`
  }

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 303) {
        const loc = res.headers.location
        https.get(loc, (r2) => {
          let d = ''
          r2.on('data', (c) => { d += c })
          r2.on('end', () => resolve(d))
        }).on('error', reject)
        return
      }
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.end()
  })
}

// ─── 파일 타입 표시명 ──────────────────────────────────────────────────────────

function mimeToLabel(mimeType) {
  const map = {
    'application/vnd.google-apps.document': 'Docs',
    'application/vnd.google-apps.spreadsheet': 'Sheets',
    'application/vnd.google-apps.presentation': 'Slides',
    'application/vnd.google-apps.folder': 'Folder',
    'application/vnd.google-apps.shortcut': 'Link',
    'application/pdf': 'PDF',
    'text/plain': 'Text',
    'text/markdown': 'MD',
    'text/csv': 'CSV',
    'application/json': 'JSON',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
    'application/vnd.openxmlformats-officedocument.presentationml.slideshow': 'PPSX',
    'application/msword': 'DOC',
    'application/vnd.ms-excel': 'XLS',
    'application/vnd.ms-powerpoint': 'PPT',
    'image/png': 'PNG',
    'image/jpeg': 'JPG',
    'image/gif': 'GIF',
    'image/svg+xml': 'SVG',
    'application/zip': 'ZIP',
  }
  if (map[mimeType]) return map[mimeType]
  const ext = mimeType.split('/').pop().split('.').pop().toUpperCase()
  return ext.length <= 6 ? ext : 'FILE'
}

function isTextExportable(mimeType) {
  return [
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.google-apps.presentation',
    'text/plain', 'text/markdown', 'text/csv',
    'application/json',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  ].includes(mimeType)
}

// ─── Render Function ──────────────────────────────────────────────────────────

const FILE_LIST_RENDER_FN = /* js */`
return function GDriveFileList({ data, onAction }) {
  const files = data && data.files ? data.files : []
  const status = data && data.status ? data.status : ''
  const dragReadyFileId = data && data.dragReadyFileId ? data.dragReadyFileId : null
  const dragReadyPath = data && data.dragReadyPath ? data.dragReadyPath : null
  const [searchQuery, setSearchQuery] = useState('')
  const [ctxMenu, setCtxMenu] = useState(null) // { fileIdx, x, y }

  // 외부 클릭 시 컨텍스트 메뉴 닫기
  useEffect(() => {
    if (!ctxMenu) return
    const handler = () => setCtxMenu(null)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [ctxMenu])

  // dragReadyPath가 준비되면 해당 파일 드래그 시작 알림 (실제 드래그는 사용자가 다시 드래그)
  useEffect(() => {
    if (dragReadyPath && dragReadyFileId) {
      // 이미 드래그 이벤트 내에서 처리되므로 별도 작업 불필요
    }
  }, [dragReadyPath, dragReadyFileId])

  function handleContextMenu(e, file) {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ file, x: e.clientX, y: e.clientY })
  }

  function handleDragStart(e, file) {
    if (dragReadyPath && dragReadyFileId === file.id) {
      e.dataTransfer.effectAllowed = 'copy'
      e.dataTransfer.setData('text/plain', '@' + dragReadyPath + ' ')
    } else {
      // 텍스트 변환이 아직 안 된 경우 — 준비 요청
      e.preventDefault()
      onAction('prepare_drag', { id: file.id, mimeType: file.mimeType, name: file.name })
    }
  }

  const containerStyle = {
    flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column',
    fontFamily: "-apple-system, 'Segoe UI', sans-serif",
  }

  return React.createElement('div', { style: containerStyle },
    // 검색바
    React.createElement('div', {
      style: { display: 'flex', gap: '6px', padding: '6px 8px', borderBottom: '1px solid #2a2a3a', flexShrink: 0 }
    },
      React.createElement('input', {
        value: searchQuery,
        onChange: (e) => setSearchQuery(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') onAction('search', { query: searchQuery }) },
        placeholder: '검색...',
        style: {
          flex: 1, background: '#1a1a25', border: '1px solid #2a2a3a', borderRadius: '4px',
          color: '#aaaacc', fontSize: '11px', padding: '3px 8px', outline: 'none',
        },
      }),
      React.createElement('button', {
        onClick: () => onAction('search', { query: searchQuery }),
        style: { background: '#2a2a3a', border: '1px solid #3a3a4a', borderRadius: '4px', color: '#8888aa', fontSize: '11px', padding: '3px 8px', cursor: 'pointer' },
      }, '검색'),
      React.createElement('button', {
        onClick: () => onAction('auth'), title: '재인증',
        style: { background: 'none', border: '1px solid #3a3a4a', borderRadius: '4px', color: '#555577', fontSize: '10px', padding: '3px 6px', cursor: 'pointer' },
      }, '🔄'),
    ),
    // 상태 표시
    status && React.createElement('div', {
      style: { padding: '3px 10px', fontSize: '10px', color: '#555577', borderBottom: '1px solid #1e1e2e', flexShrink: 0 }
    }, status),
    // 파일 목록
    React.createElement('div', { style: { flex: 1, overflowY: 'auto', overflowX: 'hidden', position: 'relative' } },
      files.length === 0
        ? React.createElement('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '80px', color: '#44445a', fontSize: '12px' }
          }, status ? '' : '결과 없음')
        : files.map((file, i) =>
            React.createElement('div', {
              key: file.id || i,
              draggable: !!file.id && file.action !== 'open_settings' && file.action !== 'auth',
              onContextMenu: (e) => { if (file.id && file.action !== 'open_settings' && file.action !== 'auth') handleContextMenu(e, file) },
              onClick: () => {
                if (file.action === 'open_settings') { onAction('open_settings'); return }
                if (file.action === 'auth') { onAction('auth'); return }
              },
              onDragStart: (e) => {
                if (!file.id || file.action === 'open_settings' || file.action === 'auth') return
                handleDragStart(e, file)
              },
              title: file.id ? '우클릭으로 메뉴 열기 | 드래그로 터미널 참조' : file.name,
              style: {
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '5px 10px',
                cursor: (file.action === 'open_settings' || file.action === 'auth') ? 'pointer' : 'grab',
              },
              onMouseEnter: (e) => { e.currentTarget.style.background = '#1e1e30' },
              onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
            },
              React.createElement('span', {
                style: { fontSize: '9px', padding: '1px 5px', borderRadius: '3px', background: '#2a2a3a', color: '#6666aa', fontWeight: 600, letterSpacing: '0.03em', flexShrink: 0 }
              }, file.badge || 'FILE'),
              React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                React.createElement('div', {
                  style: { fontSize: '12px', color: '#ccccee', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
                }, file.name),
                file.meta && React.createElement('div', {
                  style: { fontSize: '10px', color: '#44445a', marginTop: '1px' }
                }, file.meta)
              )
            )
          )
    ),
    // 컨텍스트 메뉴
    ctxMenu && React.createElement('div', {
      onClick: (e) => e.stopPropagation(),
      style: {
        position: 'fixed', left: ctxMenu.x, top: ctxMenu.y,
        background: '#1e1e30', border: '1px solid #2a2a3a', borderRadius: '6px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        zIndex: 999, minWidth: '160px', overflow: 'hidden',
        fontFamily: "-apple-system, 'Segoe UI', sans-serif",
      }
    },
      [
        { label: '🔗 링크 열기', action: 'open_link' },
        { label: '⬇️ 다운로드', action: 'download' },
        ctxMenu.file.textExportable && { label: '📋 터미널에 참조', action: 'attach' },
      ].filter(Boolean).map((item) =>
        React.createElement('div', {
          key: item.action,
          onClick: () => { onAction(item.action, { id: ctxMenu.file.id, mimeType: ctxMenu.file.mimeType, name: ctxMenu.file.name }); setCtxMenu(null) },
          style: { padding: '7px 14px', fontSize: '12px', color: '#ccccee', cursor: 'pointer' },
          onMouseEnter: (e) => { e.currentTarget.style.background = '#2a2a3a' },
          onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
        }, item.label)
      )
    )
  )
}
`

// ─── 상태 관리 ────────────────────────────────────────────────────────────────

let oauthServer = null
let currentFiles = []
let currentPanelData = { files: [], status: '', dragReadyFileId: null, dragReadyPath: null }

// ─── activate ────────────────────────────────────────────────────────────────

function activate(api) {
  const { storage } = api

  function getCredentials() {
    const clientId = storage.get('client_id')
    const clientSecret = storage.get('client_secret')
    return { clientId, clientSecret }
  }

  api.registerPanel({
    id: 'file-list',
    type: 'custom',
    title: 'Google Drive',
    defaultWidth: 420,
    minWidth: 300,
    maxWidth: 900,
    renderFn: FILE_LIST_RENDER_FN,
  })

  function renderFileList(files, status = '', extras = {}) {
    currentFiles = files
    const fileRows = files.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      webViewLink: f.webViewLink,
      badge: mimeToLabel(f.mimeType),
      meta: f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString('ko-KR') : '-',
      textExportable: isTextExportable(f.mimeType),
    }))
    currentPanelData = { files: fileRows, status, ...extras }
    api.updatePanel('file-list', { type: 'custom', data: currentPanelData }, { open: true })
  }

  async function startAuth() {
    const { clientId, clientSecret } = getCredentials()
    if (!clientId || !clientSecret) { showSetupGuide(); return }

    renderFileList([], '인증 진행 중...')
    if (oauthServer) { try { oauthServer.close() } catch {} }

    const authUrl = `${AUTH_URL}?` + new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
    }).toString()

    try { execFileSync('open', [authUrl]) } catch { api.notify('브라우저를 열 수 없습니다', 'error'); return }

    oauthServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`)
      if (url.pathname !== '/oauth2callback') { res.end(); return }

      const code = url.searchParams.get('code')
      if (!code) { res.writeHead(400); res.end('인증 코드가 없습니다'); return }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body><h2>✅ 인증 완료!</h2><p>이 창을 닫고 앱으로 돌아가세요.</p></body></html>')
      oauthServer.close(); oauthServer = null

      try {
        const body = new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
        }).toString()
        const tokenRes = await httpsRequest(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
        }, body)
        if (tokenRes.status === 200 && tokenRes.body.access_token) {
          const expiresAt = Date.now() + (tokenRes.body.expires_in - 60) * 1000
          storage.set('access_token', tokenRes.body.access_token)
          storage.set('expires_at', expiresAt)
          if (tokenRes.body.refresh_token) storage.set('refresh_token', tokenRes.body.refresh_token)
          api.notify('Google Drive 인증 완료!', 'info')
          await loadFiles('')
        } else {
          api.notify('토큰 발급 실패: ' + JSON.stringify(tokenRes.body), 'error')
          renderFileList([], '인증 실패')
        }
      } catch (err) {
        api.notify('인증 오류: ' + err.message, 'error')
        renderFileList([], '인증 오류')
      }
    })
    oauthServer.listen(REDIRECT_PORT)
  }

  async function loadFiles(query) {
    const { clientId, clientSecret } = getCredentials()
    const token = await getValidToken(storage, clientId, clientSecret)
    if (!token) { await startAuth(); return }
    try {
      renderFileList([], query ? `"${query}" 검색 중...` : '로딩 중...')
      const files = await searchFiles(token, query)
      renderFileList(files, files.length === 0 ? '결과 없음' : '')
    } catch (err) {
      if (err.message.includes('401')) {
        storage.set('access_token', null); storage.set('expires_at', 0)
        await startAuth()
      } else {
        api.notify('파일 로드 오류: ' + err.message, 'error')
        renderFileList([], '오류 발생')
      }
    }
  }

  function showSetupGuide() {
    currentFiles = []
    currentPanelData = {
      files: [{ id: 'open_settings', name: '🔑 Client ID / Secret 입력하기', badge: 'SET', meta: 'Google Cloud Console OAuth 자격증명이 필요합니다', action: 'open_settings' }],
      status: '',
    }
    api.updatePanel('file-list', { type: 'custom', data: currentPanelData }, { open: true })
  }

  api.onHook('PluginAction', async (event) => {
    if (!event.pluginId || event.pluginId !== 'gdrive-panel') return
    const { action, payload } = event
    const fileId = payload && payload.id ? payload.id : event.rowId

    if (action === 'open_settings') { api.requestSettings(); return }
    if (action === 'search') { await loadFiles((payload && payload.query) || ''); return }
    if (action === 'auth') { await startAuth(); return }

    if (!fileId) return
    const file = currentFiles.find((f) => f.id === fileId)
    if (!file) return

    const { clientId, clientSecret } = getCredentials()
    const token = await getValidToken(storage, clientId, clientSecret)
    if (!token) { await startAuth(); return }

    if (action === 'open_link') {
      if (file.webViewLink) { try { execFileSync('open', [file.webViewLink]) } catch {} }
      return
    }

    if (action === 'download') {
      try {
        renderFileList(currentFiles, `"${file.name}" 다운로드 중...`)
        const buf = await downloadFile(token, file.id, file.mimeType, file.name)
        const safeName = file.name.replace(/[/\\:*?"<>|]/g, '_')
        const dlDir = require('os').homedir() + '/Downloads'
        const dlPath = path.join(dlDir, safeName)
        fs.writeFileSync(dlPath, buf)
        api.notify(`"${file.name}" 다운로드 완료 → ~/Downloads`, 'info')
        renderFileList(currentFiles, '')
      } catch (err) {
        api.notify('다운로드 오류: ' + err.message, 'error')
        renderFileList(currentFiles, '오류 발생')
      }
      return
    }

    if (action === 'attach') {
      try {
        renderFileList(currentFiles, `"${file.name}" 준비 중...`)
        const content = await exportAsText(token, file.id, file.mimeType)
        const truncated = content.length > 20000 ? content.slice(0, 20000) + '\n\n...(내용이 잘렸습니다)' : content
        fs.mkdirSync(GDRIVE_TMP_DIR, { recursive: true })
        const safeName = file.name.replace(/[/\\:*?"<>|]/g, '_')
        const tmpPath = path.join(GDRIVE_TMP_DIR, `${safeName}.md`)
        fs.writeFileSync(tmpPath, truncated, 'utf8')
        api.ptyWrite(`@${tmpPath} `)
        api.notify(`"${file.name}" 터미널에 참조 추가`, 'info')
        renderFileList(currentFiles, '')
      } catch (err) {
        api.notify('참조 오류: ' + err.message, 'error')
        renderFileList(currentFiles, '오류 발생')
      }
      return
    }

    if (action === 'prepare_drag') {
      // 드래그 전 텍스트 파일 준비 (다음 드래그에서 사용 가능)
      try {
        const content = await exportAsText(token, file.id, file.mimeType)
        const truncated = content.length > 20000 ? content.slice(0, 20000) + '\n\n...(내용이 잘렸습니다)' : content
        fs.mkdirSync(GDRIVE_TMP_DIR, { recursive: true })
        const safeName = file.name.replace(/[/\\:*?"<>|]/g, '_')
        const tmpPath = path.join(GDRIVE_TMP_DIR, `${safeName}.md`)
        fs.writeFileSync(tmpPath, truncated, 'utf8')
        api.notify(`"${file.name}" 준비 완료 — 다시 드래그하세요`, 'info')
        // dragReadyFileId/Path 업데이트
        currentPanelData = { ...currentPanelData, dragReadyFileId: file.id, dragReadyPath: tmpPath }
        api.updatePanel('file-list', { type: 'custom', data: currentPanelData }, {})
      } catch (err) {
        api.notify('파일 준비 오류: ' + err.message, 'error')
      }
      return
    }
  })

  // 초기 로드
  const { clientId, clientSecret } = getCredentials()
  if (!clientId || !clientSecret) { showSetupGuide(); return }

  const accessToken = storage.get('access_token')
  const expiresAt = storage.get('expires_at') || 0
  const refreshToken = storage.get('refresh_token')

  if ((accessToken && Date.now() < expiresAt) || refreshToken) {
    loadFiles('')
  } else {
    currentPanelData = {
      files: [{ id: 'auth', name: '🔐 Google 계정 연결이 필요합니다', badge: 'AUTH', meta: '클릭하면 브라우저에서 로그인합니다', action: 'auth' }],
      status: '',
    }
    api.updatePanel('file-list', { type: 'custom', data: currentPanelData }, { open: true })
  }
}

module.exports = { activate }
