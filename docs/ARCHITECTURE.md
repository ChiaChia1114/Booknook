# Athena-sky 系統架構

```
 無人機（LTE／伴隨電腦）       瀏覽器（React SPA）           客戶系統
        │ Athena Link WSS          │ HTTPS + Athena Live WSS     │ REST API / Live WSS / Webhooks
        ▼                          ▼                             ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Fastify server (apps/server)                                             │
 │  ├─ routes/*        REST API v2（OpenAPI → /api/v2/schema, /api/v2/docs）  │
 │  ├─ realtime/hub    連線管理、遙測轉發、指令／ack、控制權、影像中繼、延遲量測 │
 │  ├─ realtime/swarm  群飛作業：同步起飛、航點屏障、共同返航                    │
 │  ├─ realtime/notifications  通知（持久化、即時推播、已讀游標）              │
 │  ├─ flights/        recorder（起降偵測、2 Hz 樣本）、ULog／CSV 解析、        │
 │  │                  AI 分析、航線偏差、合規檢查、匯出                         │
 │  ├─ airspace/       空域幾何、衝突檢查、授權、外部 UTM 機關、公開安全地圖、   │
 │  │                  即時 UTM 監控                                           │
 │  ├─ vision/         物件偵測（worker thread）、追蹤、地面定位、跟隨           │
 │  ├─ maintenance/    保養排程、到期計算、預測性維修、通知                      │
 │  ├─ reports/        合規與績效報表（JSON／CSV／HTML）                        │
 │  ├─ geo/            Terrarium DEM 地形（快取）、Open-Meteo 天氣             │
 │  ├─ integrations/   Webhook 派送（HMAC、重試）、日誌簿匯出                    │
 │  └─ demo/           示範資料與虛擬無人機（各自的 worker thread）             │
 │ SQLite（node:sqlite, WAL）＋ 檔案儲存（logs／firmware／payload）            │
 └──────────────────────────────────────────────────────────────────────────┘
```

## 套件

| 套件 | 職責 |
|---|---|
| `packages/shared` | 不依賴執行環境的 TypeScript：API DTO、Link／Live 協定與影像訊框編解碼、遙測檢核、測地與平面幾何（距離、方位、投影、點在多邊形內、形狀距離、緩衝區）、任務模型（驗證、統計、測繪產生器、QGC `.plan`／WPL 110 互轉）、角色權限矩陣 |
| `apps/server` | API、即時中樞、儲存、分析、整合 |
| `apps/web` | React 19 + Vite。地圖用 Leaflet，3D 用 CesiumJS（延遲載入），圖表用 uPlot 與自繪 SVG，圖示用 lucide-react；設計系統（CSS 變數、深色／淺色主題）在 `src/styles.css` |
| `apps/simulator` | 虛擬多旋翼（運動學、飛控模式、任務、返航到最近集結點、地理圍欄與電量失效保護、電池模型、馬達輸出、振動）、合成相機（光線投射地景＋HUD → JPEG）、機上 ULog 記錄器、Link 客戶端 |

## 資料模型（SQLite）

`users`、`sessions`、`password_resets`、`organisations`（settings JSON）、`memberships`（role、pilot_license）、`invitations`、`api_tokens`、`fleets`、`drones`（金鑰雜湊、韌體、最後位置）、`flights`（統計、健康分數、合規 JSON、航跡預覽；狀態 `in_progress`／`processing`（匯入中）／`completed`／`aborted`）、`flight_samples`、`flight_events`、`flight_files`、`flight_analyses`、`payload_records`、`payload_images`、`missions`（plan JSON、地形摘要）、`schedules`、`airspace_zones`、`authorizations`、`firmware_packages`、`firmware_updates`、`webhooks`、`webhook_deliveries`、`integrations`、`audit_log`、`outbox`、`swarm_operations`、`notifications`、`notification_reads`（每位使用者的已讀時間）、`maintenance_tasks`（週期、負責人、上次完成時的用量）、`maintenance_records`、`maintenance_alerts`（預測性維修通知去重）、`user_preferences`（例如 Dashboard 版面）。

資料庫遷移按版本依序執行（`db/schema.ts`）。

## 長工作分段執行（`lib/slice.ts`）

伺服器只有一個執行緒：一個請求的長時間同步計算會擋住所有組織的即時遙測、影像與指令。所以長工作都寫成 generator（`Steps<T>`），每做一小段（例如 16 個航跡點、一頁 2000 筆樣本、一批 500 筆寫入、幾千則 ULog 訊息）就 `yield`；`runSliced` 約每 8 毫秒把執行緒讓出一次（`setImmediate`），`runAtOnce` 讓測試與小資料一次跑完。用在：

* 日誌解析（`flights/ingest.ts`、`flights/ulog.ts`）：CSV 與 JSON 每次解碼約 1 MB 的文字，不會變成一個巨大的字串；ULog 的欄位值分塊收集，不會因為陣列擴充而整段複製。
* 匯入（`flights/import.ts`）：先建立 `processing` 狀態的飛行與檔案（同時確認同一檔案沒有剛被匯入），樣本與事件分批寫入後才改為 `completed`；伺服器重新啟動時移除未完成的匯入。
* 飛行後處理（`flights/finalize.ts`）：樣本以 `(t, rowid)` keyset 分頁讀取一次，分析、航線偏差（`packages/shared/src/deviation.ts` 的 `routeDeviationSteps`）與合規檢查（以時間切段）共用。
* 樣本讀取、匯出（逐頁串流）、熱度圖、航跡預覽、ULog 欄位瀏覽（`flights/ulog-cache.ts`，結果保留 10 分鐘），以及刪除飛行、無人機或組織時分批刪除樣本（`flights/cleanup.ts`）。

## 空域索引（`airspace/zone-index.ts`）

每個空域區只準備一次外框、生效時段與距離函式（以區域物件為鍵的 WeakMap，區域清單更新後自然換新）；任務檢查、空域檢查、即時監控與合規檢查先以外框略過遠處的區域。組織自己的區域讀取後保留 60 秒，新增、匯入、修改或刪除時立即失效（`airspace/providers.ts`）。

## 外部飛行授權機關（`airspace/authority.ts`）

設定 `ATHENA_UTM_AUTHORITY_URL` 時，通過本地檢查的授權申請以 `pending` 儲存後送到外部機關（[UTM_AUTHORITY.md](UTM_AUTHORITY.md)）。機關以網址識別（`authority_id`），顯示名稱可以改。每筆申請記下與機關往來的狀態（`authority_state`：`submitting` → `submitted` → `cancelling` → `closed`）與是否已送出過（`authority_sent`）。`AuthorityService` 立即送出一次，之後每隔 `ATHENA_UTM_AUTHORITY_POLL_S` 秒追蹤所有未結束的往來：依建立時間逐頁讀取（每頁 200 筆、同時 8 個呼叫，直到讀完），重送沒送到的、查詢未決定與已核准的（核准、駁回、撤銷）、撤回已取消的。送出以申請編號為冪等鍵；答覆遺失後取消的申請，依申請編號查出機關的計畫撤回。同一筆申請同時只有一個呼叫；機關的決定在交易內套用，核准前再檢查一次空域是否已被保留。狀態改變時發出 webhook、通知並寫稽核紀錄。伺服器關閉時等進行中的呼叫結束後才關資料庫。

## 即時資料流

1. 無人機連線、驗證，送出 `hello`。Hub 廣播 `status` 並觸發 `drone.online`。
2. 每則 `telemetry` 會：
   * 先檢核數值範圍；
   * 轉送給有訂閱的觀看者（附上換算成雲端時鐘的拍攝時間 `at`），連線壅塞時只保留每台無人機最新的一筆，等觀看者跟上再送；
   * 交給 FlightRecorder（偵測起飛／落地，每秒批次寫入樣本與事件）；
   * 每 10 秒更新一次最後位置；
   * 每秒觸發一次 `telemetry` Webhook。
3. 指令：觀看者 → Hub（檢查角色、控制權、參數）→ 無人機 → ack → 廣播。每個指令都寫入稽核紀錄。
4. 影像：只在有觀看者時要求串流。回報收到訊息（`ack`）的觀看者有流量控制（`realtime/flow.ts`，做法類似 BBR）：從回報學到連線最短的往返時間與送達速率，影像只在在途的量不超過「往返時間內送得到的量加上一小段排隊（0.25 秒、最多 64 KB 或各路同時到的影格、至少一個影格）」時才送，並依送達速率稍快一點的節奏送出；送一個要超過 1.5 秒的影格不送（每 30 秒送一個重新量測）。訊息等待回報超過「以送達速率離開佇列再加往返時間」0.5 秒時判定壅塞：丟棄影格，持續 1 秒後每台無人機只保留最新一筆遙測；在途的資料送完之前不再送影像，這段期間資料送達的速率就是連線此後的速率，往返時間也重新量（變遠的連線重新起步）。往返時間沒有上限，遠的連線照樣收到全部遙測；系統與網路的緩衝區不會累積延遲——連線突然變慢的那一刻，已在路上的資料（約一個往返的影像量）仍要以新的速率送完，之後不再累積（`apps/server/test/flow-control.test.ts` 以模擬的各種連線驗證）。不回報的觀看者在 socket 緩衝超過 1 MB 時丟棄。無人機每 2 秒以 `ping` 量測時鐘，雲端取最近 10 秒內「無人機時鐘比雲端快多少」最小的上界（`packages/shared/src/clock.ts`；時鐘可能被調快時只採用新的量測），影格的擷取時間與遙測、ADS-B 的時間都換算成雲端時鐘轉給觀看者，並且不晚於「收到的時間減去最近最短的往返時間」：上行再慢也不會被當成比實際新——只有時鐘在兩次量測之間被調快、上行又同時更慢時才可能短暫例外（見 `docs/LINK_PROTOCOL.md`）。觀看者的 `ping` 由雲端以自己量到的往返時間回答，不轉送給無人機；每條連線與每位成員（所有連線合計）的訊息、同時的連線數、指令數、影像切換與等待回覆的指令都有上限，不能控制無人機的角色送來的指令立即拒絕：不論開幾條連線，沒有人能塞住無人機的控制連線或拖慢別人的指令。沒有新資料的無人機不會收到讓它移動的指令。
5. 飛行結束：依序執行 AI 分析、合規檢查、`flight.ended`／`flight.analyzed`／`alert.raised` Webhook、日誌簿自動匯出。
6. 斷線：保留飛行紀錄一段寬限時間（`ATHENA_LINK_LOSS_GRACE_S`）。重新連線就繼續記錄，否則標記為 aborted。

## AI 飛行分析（`flights/analysis.ts`）

* **規則診斷**：振動（ArduPilot 慣用門檻：30／60 m/s²）、馬達輸出不平衡與飽和、每顆電芯的電壓驟降與最低電壓、落地剩餘電量、GNSS 衛星數與 HDOP、姿態震盪（高通 RMS）、最大傾角、觸地垂直速度、斷線、自駕儀錯誤、失效保護觸發。
* **個體基線異常偵測**：與同一台無人機最近 20 次飛行比較耗電率、平均電流、振動、馬達不平衡的 z-score（> 2.5 警告，> 4 嚴重），在故障發生前找出機械劣化。
* **健康分數**：100 減去扣分（嚴重 −25，警告 −8）。
* **航線偏差**（任務飛行）：在局部投影中計算每個空中樣本到規劃航線最近航段的橫向距離，得到平均、95 百分位、最大值、超出 10 m 走廊的時間比例；把航段切成 5 m 小格標記實際飛過的部分得到完成度；高度偏差只計算航段中（第一次與最後一次到達規劃高度之間）。不計入健康分數。

## 維修與預測性維修（`maintenance/`）

* **保養排程**：每項工作可設定飛行時數、飛行次數、天數三種週期，任一先到為準；用量比例 ≥ 90% 為「即將到期」，≥ 100% 為「逾期」。完成時記錄當下用量並重新起算。`overdueAt()` 以當時的用量與當時之前最後一次完成紀錄，判斷過去某趟飛行起飛時是否有逾期保養（報表的合規段落使用）。
* **預測性維修**：每台無人機最近 60 趟飛行的分析指標對累計飛行時數做線性迴歸，推算到達門檻的剩餘時數。
* **通知**：伺服器啟動 15 秒後、每小時、每趟飛行結束時檢查；狀態改變才通知一次（`notified_status`、`maintenance_alerts`）。

## 空域衝突與合規

所有形狀都化為「核心幾何＋緩衝半徑」（點、折線、多邊形），在局部等距投影中計算最短距離（相交或包含時為 0）。衝突檢查再加上高度區間與時間窗重疊：

* 禁航、限航、臨時限制：阻擋；
* 管制、危險區：需人工審核；
* 地面危害：50 m 內提出建議。

已核准的保留在所有組織之間共享，因為空域是共享的。授權申請在交易中先檢查再寫入，避免兩個重疊的申請同時被核准。

## 安全設計

請見 README 的「安全性」一節。重點：

* 所有權杖都只存雜湊；Webhook 與整合密鑰以 AES-256-GCM 加密；
* Cookie Session 搭配 CSRF 雙重提交；
* 依角色檢查權限，組織之間以 404 隔離；
* WebSocket 檢查 Origin；
* 對外連線阻擋內網位址，防止 SSRF；
* 上傳有大小限制，儲存路徑由伺服器產生。
