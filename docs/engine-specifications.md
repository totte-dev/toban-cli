# Agent Engine Specifications

toban-cli がサポートする各エージェントエンジンの仕様と、プロジェクト設定の読み込み規約をまとめる。

## エンジン一覧

| Engine | CLI Command | Headless Flag | Auto-Approve Flag | Status |
|--------|------------|---------------|-------------------|--------|
| claude | `claude` | `--print` | `--dangerously-skip-permissions` | Production |
| gemini | `gemini` | `-p` | `-y` (yolo) | Verified |
| codex | `codex` | `--quiet` | N/A | Untested |
| mock | `bash -c <script>` | N/A | N/A | E2E Testing |

---

## Claude Code

### プロジェクト設定の読み込み

| ファイル/ディレクトリ | 場所 | 用途 | `--print`で読まれるか |
|---|---|---|---|
| `CLAUDE.md` | リポルート | プロジェクト指示書（コーディング規約、ルール等） | **Yes** |
| `.claude/settings.json` | リポルート | プロジェクト設定（MCP servers, permissions等） | Yes |
| `.claude/commands/` | リポルート | カスタムスラッシュコマンド | Yes |
| `~/.claude/CLAUDE.md` | ユーザーホーム | グローバル指示書（全プロジェクト共通） | Yes |
| `~/.claude/settings.json` | ユーザーホーム | ユーザー設定 | Yes |
| `~/.claude/skills/` | ユーザーホーム | インストール済みスキル | Yes |
| `~/.claude/commands/` | ユーザーホーム | ユーザーレベルのカスタムコマンド | Yes |

### toban-cli での起動コマンド

```
claude --dangerously-skip-permissions --print <prompt>
```

- `--print`: 非対話モード。結果を stdout に出力して終了
- `--dangerously-skip-permissions`: ツール実行の確認をスキップ
- CWD の `CLAUDE.md` が自動読み込みされる
- `CLAUDECODE` 環境変数を unset してネストセッション検出を回避

### 追加フラグ（必要に応じて利用可能）

| フラグ | 用途 |
|---|---|
| `--append-system-prompt <prompt>` | デフォルトシステムプロンプトに追記 |
| `--system-prompt <prompt>` | システムプロンプトを完全に上書き |
| `--setting-sources <sources>` | 読み込む設定ソースを指定（`user,project,local`） |
| `--settings <file-or-json>` | 追加設定ファイルを指定 |
| `--agent <agent>` | 使用するエージェント定義を指定 |

### worktree での挙動

- git worktree にはリポの全ファイルがチェックアウトされる
- `CLAUDE.md` と `.claude/` が git 管理下にあれば、worktree にも含まれる
- `.gitignore` に含まれている場合は worktree に含まれない

---

## Gemini CLI

### プロジェクト設定の読み込み

| ファイル/ディレクトリ | 場所 | 用途 | `-p`で読まれるか |
|---|---|---|---|
| `GEMINI.md` | リポルート | プロジェクト指示書 | **Yes** |
| `.gemini/GEMINI.md` | リポルート | プロジェクト指示書（別パス） | **Yes** |
| `.gemini/settings.json` | リポルート | プロジェクト設定 | Yes |
| `~/.gemini/settings.json` | ユーザーホーム | ユーザー設定 | Yes |

### toban-cli での起動コマンド

```
gemini -y -p <prompt>
```

- `-p`: 非対話（headless）モード。結果を stdout に出力
- `-y`: YOLO モード。全ツール実行を自動承認
- CWD の `GEMINI.md` が自動読み込みされる

### 拡張機能

| 機能 | コマンド | 説明 |
|---|---|---|
| Skills | `gemini skills install <source>` | エージェントスキルのインストール |
| Extensions | `gemini extensions install <source>` | CLI拡張のインストール |
| Hooks | `gemini hooks migrate` | Claude Code からの hook 移行 |
| Policy | `--policy <file>` | ポリシーファイルによるツール制御 |

### 注意事項

- Gemini CLI は quota 制限に達するとリトライを行う（5-10秒の遅延）
- `-p` モードでもプロセス終了に20-30秒かかる場合がある
- stdin をパイプで閉じると終了が安定する

---

## Mock Engine

### 用途

LLM を呼ばずにスプリントサイクルを E2E テストするためのエンジン。トークン消費ゼロ。

### 動作

```bash
# 擬似的な作業を実行
echo "[mock] Agent ${name} starting task ${taskId}..."
mkdir -p .mock-output
echo "Mock output..." > .mock-output/${taskId}.txt
git add .mock-output/${taskId}.txt
git commit -m "mock: simulated work for task ${taskId}"
echo 'RETRO_JSON:{"went_well":"...","to_improve":"...","suggested_tasks":[]}'
```

- `.mock-output/` にダミーファイルを作成
- git commit を実行
- `RETRO_JSON` を stdout に出力（retro コメント用）
- 約5秒で完了

### テスト実行

```bash
API_KEY=tb_xxx npm run test:e2e:mock
```

---

## エンジン共通事項

### toban-cli によるプロンプト注入

各エンジンの設定ファイル（`CLAUDE.md` / `GEMINI.md`）に加え、toban-cli は以下をプロンプト引数として注入する：

- ロール定義（builder, manager 等）
- プロジェクト仕様
- タスク詳細（タイトル、説明、優先度）
- API リファレンス（status 更新、タスク管理、メッセージ送信）
- ワークフロー指示（ブランチ作成 → 実装 → PR → retro）
- セキュリティルール

これにより、エンジン固有の設定ファイルがなくても最低限の動作が保証される。

### RETRO_JSON プロトコル

全エンジン共通で、エージェントの stdout に以下の行を出力するとレトロスペクティブコメントとして記録される：

```
RETRO_JSON:{"went_well":"...","to_improve":"...","suggested_tasks":[{"title":"...","priority":"p1"}]}
```

### worktree の扱い

- toban-cli は各タスクごとに git worktree を作成
- エージェントは worktree 内で作業
- 完了後、worktree のブランチをベースブランチにマージ
- worktree はマージ後に自動削除
