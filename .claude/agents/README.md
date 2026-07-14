# Agent Team 技能庫

> 一位資深工程師的退休交接：一支完整的 AI Agent 開發團隊定義庫，
> 供初級工程師學習「各角色該怎麼思考」，也供 AI 模型（Claude Code subagents 等）直接載入使用。

## 這是什麼

每個 `.md` 檔案定義一個專業 agent 角色。格式遵循 Claude Code subagent 慣例：

```markdown
---
name: agent-識別名（kebab-case，與檔名一致）
description: 何時使用此 agent。含觸發關鍵字與「PROACTIVELY」提示，供主模型自動委派判斷。
tools: 最小權限工具清單（省略則繼承全部）
model: sonnet | opus | haiku（依任務複雜度分級，控制成本）
---

系統提示詞正文：角色定位、職責、工作流程、輸出格式、檢核清單、交接介面、禁區。
```

安裝方式（Claude Code）：

- 專案層級：複製到 `<專案>/.claude/agents/`
- 使用者層級：複製到 `~/.claude/agents/`
- 之後主對話會依 `description` 自動委派，或手動指定：`用 code-reviewer 檢查這個 diff`

## 團隊編制

| Agent | 檔案 | 角色 | model |
|---|---|---|---|
| 指揮官 | [orchestrator.md](orchestrator.md) | 任務拆解、委派、整合、最終把關 | opus |
| 系統架構師 | [system-architect.md](system-architect.md) | 架構設計、技術選型、trade-off 分析 | opus |
| UI/UX 設計師 | [ui-ux-designer.md](ui-ux-designer.md) | 資訊架構、互動流程、視覺規範、無障礙 | sonnet |
| 前端工程師 | [frontend-developer.md](frontend-developer.md) | UI 實作、狀態管理、效能、瀏覽器相容 | sonnet |
| 後端工程師 | [backend-developer.md](backend-developer.md) | API、業務邏輯、認證授權、可觀測性 | sonnet |
| 資料庫專家 | [database-specialist.md](database-specialist.md) | Schema 設計、查詢優化、遷移、備援 | sonnet |
| 資料分析師 | [data-analyst.md](data-analyst.md) | 指標定義、SQL 分析、視覺化、洞察報告 | sonnet |
| 測試工程師 (QA) | [qa-test-engineer.md](qa-test-engineer.md) | 測試策略、自動化測試、邊界案例、回歸 | sonnet |
| 除錯專家 | [debugger.md](debugger.md) | 根因分析、重現、最小修復、防再發 | opus |
| Git 管理員 | [git-manager.md](git-manager.md) | 分支策略、commit 規範、合併衝突、release | haiku |
| 程式碼審查員 | [code-reviewer.md](code-reviewer.md) | 正確性、可維護性、安全性審查 | opus |
| DevOps 工程師 | [devops-engineer.md](devops-engineer.md) | CI/CD、容器化、部署、監控告警 | sonnet |
| 資安審查員 | [security-auditor.md](security-auditor.md) | 弱點掃描、OWASP、機敏資料、依賴審計 | opus |
| 技術文件師 | [docs-writer.md](docs-writer.md) | README、API 文件、ADR、教學 | haiku |

## 標準工作流

```
需求進入
   │
   ▼
orchestrator ──── 需求含糊？先釐清，再拆解成可驗收的子任務
   │
   ├─► system-architect ─── 新系統／大改動：先出設計，定介面契約
   │        │
   │        ├─► database-specialist ── schema 與資料流
   │        └─► ui-ux-designer ─────── 畫面流程與規範
   │
   ├─► backend-developer ⇄ frontend-developer ── 依契約並行實作
   │
   ├─► qa-test-engineer ── 實作完成即測試；發現缺陷 ──► debugger
   │                                                      │
   │                             修復後回 QA 回歸驗證 ◄───┘
   ├─► code-reviewer + security-auditor ── 合併前雙審
   │
   ├─► git-manager ── 分支、commit、PR、release
   │
   └─► devops-engineer ── 部署與監控；docs-writer 同步文件
```

核心原則：

1. **單一職責**：每個 agent 只做一件事並做到專業；跨界問題交接，不越權硬做。
2. **契約先行**：介面（API schema、元件 props、資料表）先議定，實作才並行。
3. **可驗收**：每個子任務都有明確完成定義（DoD），QA 依此驗收。
4. **最小權限**：agent 的 `tools` 只給必要工具；審查類 agent 一律唯讀。
5. **留下證據**：決策寫 ADR、缺陷寫重現步驟、修復附回歸測試。

## 給初級工程師的閱讀順序

1. 先讀 `orchestrator.md` — 理解任務如何被拆解與驗收。
2. 讀你職能對應的 agent — 那是該角色的思考框架與檢核清單。
3. 讀 `code-reviewer.md` 與 `debugger.md` — 這兩份是所有工程師的通用內功。
4. 每份檔案末尾的「禁區」章節，是前人踩過的坑，價值最高。

## 設計參考

格式與寫法綜合自社群高評價實踐：Anthropic 官方 subagents 文件、
wshobson/agents、VoltAgent/awesome-claude-code-subagents、humanlayer 的
agent 設計準則（單一職責、最小工具、明確觸發描述、可交接輸出）。
