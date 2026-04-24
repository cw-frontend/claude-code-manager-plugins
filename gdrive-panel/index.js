'use strict'

const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const GDRIVE_TMP_DIR = '/tmp/claude-gdrive'

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
  let q
  if (!query) {
    q = 'trashed=false'
  } else {
    // 공백/언더스코어로 토큰 분리 후 각 토큰을 name contains AND 조건으로 검색
    // fullText contains 는 내용까지 검색해 노이즈가 많으므로 name 기준 유지
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

async function getFileContent(token, fileId, mimeType) {
  // Google Docs/Sheets/Slides → 텍스트로 export
  // Office 파일(DOCX/XLSX/PPTX) → Google 형식으로 변환 후 텍스트 export
  let url
  if (mimeType === 'application/vnd.google-apps.document') {
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=text/plain`
  } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=text/csv`
  } else if (mimeType === 'application/vnd.google-apps.presentation') {
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=text/plain`
  } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=text/plain`
  } else if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=text/csv`
  } else if (
    mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.slideshow'
  ) {
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
  // 알 수 없는 타입은 확장자 부분만 대문자로 (최대 6자)
  const ext = mimeType.split('/').pop().split('.').pop().toUpperCase()
  return ext.length <= 6 ? ext : 'FILE'
}

function isReadable(mimeType) {
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
    const rows = files.map((f) => ({
      _id: f.id,
      _mimeType: f.mimeType,
      _webViewLink: f.webViewLink,
      _title: f.name,
      _badge: mimeToLabel(f.mimeType),
      _meta: f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString('ko-KR') : '-',
      action: isReadable(f.mimeType) ? '참조' : '열기',
    }))

    api.updatePanel('file-list', {
      type: 'table',
      columns: [],
      rows,
      status,
      sortable: false,
      listMode: true,
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
      columns: [],
      rows: [
        { _id: 'open_settings', action: 'open_settings', _title: '🔑 Client ID / Secret 입력하기', _subtitle: 'Google Cloud Console OAuth 자격증명이 필요합니다' },
      ],
      listMode: true,
    }, { open: true })
  }

  // ── 행 클릭 처리 ───────────────────────────────────────────
  api.onHook('PluginAction', async (event) => {
    if (!event.pluginId || event.pluginId !== 'gdrive-panel') return
    const { action, rowId } = event

    if (action === 'open_settings') {
      api.requestSettings()
      return
    }

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

    // 로딩 상태 표시
    renderFileList(currentFiles, `"${file.name}" 불러오는 중...`)
    api.updatePanel('preview', {
      type: 'markdown',
      content: `### ${file.name}\n\n불러오는 중...`,
    }, { open: true })

    try {
      const content = await getFileContent(token, file.id, file.mimeType)
      const truncated = content.length > 20000 ? content.slice(0, 20000) + '\n\n...(내용이 잘렸습니다)' : content

      if (action === '참조') {
        // /tmp/claude-gdrive/{파일명}.md 에 저장 후 @경로 전송
        renderFileList(currentFiles, `"${file.name}" PTY 전송 중...`)
        fs.mkdirSync(GDRIVE_TMP_DIR, { recursive: true })
        const safeName = file.name.replace(/[/\\:*?"<>|]/g, '_')
        const tmpPath = path.join(GDRIVE_TMP_DIR, `${safeName}.md`)
        fs.writeFileSync(tmpPath, truncated, 'utf8')
        api.ptyWrite(`@${tmpPath} 이 문서를 참고해줘\n`)
        api.notify(`"${file.name}" 참조 전송 완료`, 'info')
        renderFileList(currentFiles, `"${file.name}" 전송 완료 ✅`)
        api.updatePanel('preview', {
          type: 'markdown',
          content: `### ${file.name}\n\n> \`@${tmpPath}\` 전송 완료 ✅\n\n\`\`\`\n${truncated.slice(0, 3000)}${truncated.length > 3000 ? '\n...(미리보기 3000자)' : ''}\n\`\`\``,
        }, { open: true })
      } else {
        renderFileList(currentFiles, '')
        api.updatePanel('preview', {
          type: 'markdown',
          content: `### ${file.name}\n\n\`\`\`\n${truncated}\n\`\`\``,
        }, { open: true })
      }
    } catch (err) {
      renderFileList(currentFiles, `오류: ${err.message}`)
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
      columns: [],
      rows: [{ _id: 'auth', action: 'auth', _title: '🔐 Google 계정 연결이 필요합니다', _subtitle: '클릭하면 브라우저에서 로그인합니다' }],
      listMode: true,
    }, { open: true })
  }
}

module.exports = { activate }
