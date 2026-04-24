'use strict'

const http = require('http')
const https = require('https')
const { execSync } = require('child_process')

// ─── OAuth2 설정 ──────────────────────────────────────────────────────────────

// CLIENT_ID / CLIENT_SECRET 은 코드에 없음 — storage에서 읽어옴
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
  const q = query
    ? `name contains '${query.replace(/'/g, "\\'")}' and trashed=false`
    : 'trashed=false'
  const fields = 'files(id,name,mimeType,modifiedTime,webViewLink,size)'
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=30&orderBy=modifiedTime desc`

  const res = await httpsRequest(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status !== 200) throw new Error(`Drive API 오류: ${res.status}`)
  return res.body.files || []
}

async function getFileContent(token, fileId, mimeType) {
  // Google Docs/Sheets/Slides → 텍스트로 export
  let url
  if (mimeType === 'application/vnd.google-apps.document') {
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=text/plain`
  } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=text/csv`
  } else if (mimeType === 'application/vnd.google-apps.presentation') {
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=text/plain`
  } else {
    // 일반 파일 다운로드 (텍스트 계열)
    url = `${DRIVE_API}/files/${fileId}?alt=media`
  }

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      // 리다이렉트 처리
      if (res.statusCode === 302 || res.statusCode === 303) {
        const loc = res.headers.location
        https.get(loc, { headers: { Authorization: `Bearer ${token}` } }, (r2) => {
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
    'application/pdf': 'PDF',
    'text/plain': 'Text',
    'text/markdown': 'Markdown',
  }
  return map[mimeType] || mimeType.split('/').pop()
}

function isReadable(mimeType) {
  return [
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.google-apps.presentation',
    'text/plain', 'text/markdown', 'text/csv',
    'application/json',
  ].includes(mimeType)
}

// ─── 상태 관리 ────────────────────────────────────────────────────────────────

let oauthServer = null
let currentFiles = []

// ─── activate ────────────────────────────────────────────────────────────────

function activate(api) {
  const { storage } = api

  // ── Client ID / Secret은 storage에서 읽음 ─────────────────
  function getCredentials() {
    const clientId = storage.get('client_id')
    const clientSecret = storage.get('client_secret')
    return { clientId, clientSecret }
  }

  // ── 패널 등록 ──────────────────────────────────────────────
  api.registerPanel({
    id: 'file-list',
    type: 'table',
    title: 'Google Drive',
    defaultWidth: 420,
    minWidth: 300,
    maxWidth: 900,
  })

  api.registerPanel({
    id: 'preview',
    type: 'markdown',
    title: 'Drive 문서 미리보기',
    defaultWidth: 500,
    minWidth: 300,
    maxWidth: 900,
  })

  // ── 파일 목록 렌더링 ───────────────────────────────────────
  function renderFileList(files, status = '') {
    currentFiles = files
    const columns = [
      { key: 'name', label: '파일명', width: 220 },
      { key: 'type', label: '타입', width: 60 },
      { key: 'modified', label: '수정일', width: 80 },
      { key: 'action', label: '', width: 40 },
    ]
    const rows = files.map((f) => ({
      _id: f.id,
      _mimeType: f.mimeType,
      _webViewLink: f.webViewLink,
      name: f.name,
      type: mimeToLabel(f.mimeType),
      modified: f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString('ko-KR') : '-',
      action: isReadable(f.mimeType) ? '참조' : '열기',
    }))

    api.updatePanel('file-list', {
      type: 'table',
      columns,
      rows,
      status,
      sortable: false,
    }, { open: true })
  }

  // ── 인증 플로우 ────────────────────────────────────────────
  async function startAuth() {
    const { clientId, clientSecret } = getCredentials()
    if (!clientId || !clientSecret) {
      showSetupGuide()
      return
    }

    renderFileList([], '인증 진행 중...')
    if (oauthServer) { try { oauthServer.close() } catch {} }

    const redirectUri = `http://localhost:${REDIRECT_PORT}/oauth2callback`
    const authUrl = `${AUTH_URL}?` + new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
    }).toString()

    try { execSync(`open "${authUrl}"`) } catch { api.notify('브라우저를 열 수 없습니다: ' + authUrl, 'error'); return }

    oauthServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`)
      if (url.pathname !== '/oauth2callback') { res.end(); return }

      const code = url.searchParams.get('code')
      if (!code) { res.writeHead(400); res.end('인증 코드가 없습니다'); return }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body><h2>✅ 인증 완료!</h2><p>이 창을 닫고 앱으로 돌아가세요.</p></body></html>')
      oauthServer.close()
      oauthServer = null

      try {
        const body = new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
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

  // ── 파일 로드 ──────────────────────────────────────────────
  async function loadFiles(query) {
    const { clientId, clientSecret } = getCredentials()
    const token = await getValidToken(storage, clientId, clientSecret)
    if (!token) {
      await startAuth()
      return
    }
    try {
      renderFileList([], query ? `"${query}" 검색 중...` : '로딩 중...')
      const files = await searchFiles(token, query)
      renderFileList(files, files.length === 0 ? '결과 없음' : '')
    } catch (err) {
      if (err.message.includes('401')) {
        storage.set('access_token', null)
        storage.set('expires_at', 0)
        await startAuth()
      } else {
        api.notify('파일 로드 오류: ' + err.message, 'error')
        renderFileList([], '오류 발생')
      }
    }
  }

  // ── 설정 안내 화면 ─────────────────────────────────────────
  function showSetupGuide() {
    api.updatePanel('file-list', {
      type: 'table',
      columns: [{ key: 'msg', label: 'Google Drive 설정', width: 380 }],
      rows: [
        { _id: 'guide1', msg: '1. Google Cloud Console에서 OAuth 앱을 만드세요' },
        { _id: 'guide2', msg: '2. 아래 storage.json에 client_id / client_secret 입력' },
        { _id: 'guide3', msg: `3. 경로: ~/.claude-code-manager/plugins/gdrive-panel/storage.json` },
        { _id: 'guide4', msg: '4. 플러그인 리로드 후 다시 시도하세요' },
      ],
      status: 'Client ID / Secret이 설정되지 않았습니다',
    }, { open: true })
  }

  // ── 행 클릭 처리 ───────────────────────────────────────────
  api.onHook('PluginAction', async (event) => {
    if (!event.pluginId || event.pluginId !== 'gdrive-panel') return
    const { action, rowId } = event

    if (action === 'search') {
      await loadFiles(event.query || '')
      return
    }

    if (action === 'auth') {
      await startAuth()
      return
    }

    if (action === 'logout') {
      storage.set('access_token', null)
      storage.set('refresh_token', null)
      storage.set('expires_at', 0)
      renderFileList([], '로그아웃됨')
      api.notify('Google Drive 로그아웃', 'info')
      return
    }

    if (!rowId) return
    const file = currentFiles.find((f) => f.id === rowId)
    if (!file) return

    if (!isReadable(file.mimeType)) {
      // 브라우저에서 열기
      try { execSync(`open "${file.webViewLink}"`) } catch {}
      return
    }

    // 파일 내용 읽기
    const { clientId, clientSecret } = getCredentials()
    const token = await getValidToken(storage, clientId, clientSecret)
    if (!token) { await startAuth(); return }

    try {
      api.updatePanel('preview', {
        type: 'markdown',
        content: `### ${file.name}\n\n불러오는 중...`,
      }, { open: true })

      const content = await getFileContent(token, file.id, file.mimeType)
      const truncated = content.length > 20000 ? content.slice(0, 20000) + '\n\n...(내용이 잘렸습니다)' : content

      if (action === '참조') {
        // PTY에 주입
        const ref = `다음 문서를 참고해서 작업해줘.\n\n[Google Drive: ${file.name}]\n\`\`\`\n${truncated}\n\`\`\`\n`
        api.ptyWrite(ref)
        api.notify(`"${file.name}" 참조 전송 완료`, 'info')
        // 미리보기도 같이 표시
        api.updatePanel('preview', {
          type: 'markdown',
          content: `### ${file.name}\n\n> Claude에게 참조 전송 완료 ✅\n\n\`\`\`\n${truncated.slice(0, 3000)}${truncated.length > 3000 ? '\n...(미리보기 3000자)' : ''}\n\`\`\``,
        }, { open: true })
      } else {
        // 미리보기만
        api.updatePanel('preview', {
          type: 'markdown',
          content: `### ${file.name}\n\n\`\`\`\n${truncated}\n\`\`\``,
        }, { open: true })
      }
    } catch (err) {
      api.notify('파일 읽기 오류: ' + err.message, 'error')
    }
  })

  // ── 초기 로드 ──────────────────────────────────────────────
  const { clientId, clientSecret } = getCredentials()
  if (!clientId || !clientSecret) {
    showSetupGuide()
    return
  }

  const accessToken = storage.get('access_token')
  const expiresAt = storage.get('expires_at') || 0
  const refreshToken = storage.get('refresh_token')

  if ((accessToken && Date.now() < expiresAt) || refreshToken) {
    loadFiles('')
  } else {
    api.updatePanel('file-list', {
      type: 'table',
      columns: [{ key: 'msg', label: 'Google Drive', width: 300 }],
      rows: [{ _id: 'auth', msg: '🔐 Google 계정 연결이 필요합니다' }],
      status: '행을 클릭하면 브라우저에서 로그인합니다',
    }, { open: true })
  }
}

module.exports = { activate }
