# Claude Code Manager Plugins

Claude Code에 기능을 추가하는 플러그인 저장소입니다.

## 플러그인 목록

| 플러그인 | 설명 | 버전 |
|---|---|---|
| [git-diff-panel](#git-diff-panel) | Claude가 파일을 수정할 때 git diff를 오른쪽 패널에 표시 | 1.0.0 |

---

## git-diff-panel

Claude가 파일을 수정할 때마다 해당 레포지토리의 git diff를 오른쪽 패널에 실시간으로 표시합니다.

### 기능

- **실시간 diff 표시**: `Edit`, `Write`, `MultiEdit`, `Bash` 도구 사용 후 자동으로 diff 갱신
- **멀티 레포 지원**: 여러 레포지토리를 동시에 트래킹하며 각 레포별로 독립 패널 생성
- **세션 연동**: 활성 세션 전환 시 해당 세션의 레포 패널만 표시, 나머지는 자동 숨김
- **자동 접기/펼치기**: 변경 사항이 없으면 패널 자동 접힘, 변경 발생 시 자동 펼침
- **staged + unstaged**: `git diff HEAD` 우선, 없으면 `git diff --cached` 표시

### 패널 설정

| 항목 | 값 |
|---|---|
| 기본 너비 | 380px |
| 최소 너비 | 220px |
| 최대 너비 | 800px |

---

## 플러그인 추가 방법

`registry.json`에 새 플러그인 항목을 추가합니다.

```json
{
  "id": "플러그인-id",
  "name": "플러그인 이름",
  "description": "플러그인 설명",
  "version": "1.0.0",
  "author": "작성자",
  "repo": "owner/repo",
  "subdir": "플러그인-디렉토리"
}
```

각 플러그인 디렉토리에는 다음 파일이 필요합니다.

```
플러그인-디렉토리/
├── plugin.json   # 플러그인 메타데이터
└── index.js      # activate(api) 함수를 export하는 진입점
```

### plugin.json 형식

```json
{
  "id": "플러그인-id",
  "name": "플러그인 이름",
  "version": "1.0.0",
  "author": "작성자",
  "description": "플러그인 설명",
  "main": "index.js"
}
```

### index.js 기본 구조

```js
'use strict'

function activate(api) {
  // api.registerPanel(...)
  // api.onHook('PostToolUse', (event) => { ... })
  // api.onHook('ActiveSessionChanged', (event) => { ... })
}

module.exports = { activate }
```

### 사용 가능한 API

| 메서드 | 설명 |
|---|---|
| `api.registerPanel(options)` | 새 패널 등록 |
| `api.updatePanel(id, content, options)` | 패널 내용 갱신 |
| `api.hidePanel(id)` | 패널 숨김 |
| `api.onHook(hookName, handler)` | Claude Code 훅 이벤트 구독 |

### 지원 훅 이벤트

| 훅 | 발생 시점 |
|---|---|
| `PostToolUse` | 도구 실행 완료 후 (`event.tool_name`, `event.tool_input` 포함) |
| `ActiveSessionChanged` | 활성 세션 전환 시 (`event.cwds` 배열 포함) |
