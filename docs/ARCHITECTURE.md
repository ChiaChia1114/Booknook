# Athena-sky 系統架構

```
 無人機（LTE／伴隨電腦）       瀏覽器（React SPA）           客戶系統
        │ Athena Link WSS          │ HTTPS + Athena Live WSS     │ REST API / Live WSS / Webhooks
        ▼                          ▼                             ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Fastify server (apps/server)                                             │
 │  ├─ routes/*        REST API v2（OpenAPI → /api/v2/schema, /api/v2/docs）  │
 │  ├─ realtime/hub    連線管理、遙測轉發、指令／ack、控制權、影像中繼、延遲量測 │
 │  ├─ flights/        recorder（起降偵測、2 Hz 樣本）、ULog／CSV 解析、        │
 │  │                  AI 分析、合規檢查、匯出                                 │
 │  ├─ airspace/       空域幾何、衝突檢查、授權、公開安全地圖                     │
 │  ├─ geo/            Terrarium DEM 地形（快取）、Open-Meteo 天氣             │
 │  ├─ integrations/   Webhook 派送（HMAC、重試）、日誌簿匯出                    │
 │  └─ demo/           示範資料與程序內虛擬無人機                                │
 │ SQLite（node:sqlite, WAL）＋ 檔案儲存（logs／firmware／payload）            │
 └──────────────────────────────────────────────────────────────────────────┘
```

## 套件

| 套件 | 職責 |
|---|---|
| `packages/shared` | 不依賴執行環境的 TypeScript：API DTO、Link／Live 協定與影像訊框編解碼、遙測檢核、測地與平面幾何（距離、方位、投影、點在多邊形內、形狀距離、緩衝區）、任務模型（驗證、統計、測繪產生器、QGC `.plan`／WPL 110 互轉）、角色權限矩陣 |
| `apps/server` | API、即時中樞、儲存、分析、整合 |
| `apps/web` | React 19 + Vite。地圖用 Leaflet，3D 用 CesiumJS（延遲載入），圖表用 uPlot |
| `apps/simulator` | 虛擬多旋翼（運動學、飛控模式、任務、返航到最近集結點、地理圍欄與電量失效保護、電池模型、馬達輸出、振動）、合成相機（光線投射地景＋HUD → JPEG）、機上 ULog 記錄器、Link 客戶端 |

## 資料模型（SQLite）

`users`、`sessions`、`password_resets`、`organisations`（settings JSON）、`memberships`（role、pilot_license）、`invitations`、`api_tokens`、`fleets`、`drones`（金鑰雜湊、韌體、最後位置）、`flights`（統計、健康分數、合規 JSON）、`flight_samples`、`flight_events`、`flight_files`、`flight_analyses`、`payload_records`、`payload_images`、`missions`（plan JSON、地形摘要）、`schedules`、`airspace_zones`、`authorizations`、`firmware_packages`、`firmware_updates`、`webhooks`、`webhook_deliveries`、`integrations`、`audit_log`、`outbox`。

資料庫遷移按版本依序執行（`db/schema.ts`）。

## 即時資料流

1. 無人機連線、驗證，送出 `hello`。Hub 廣播 `status` 並觸發 `drone.online`。
2. 每則 `telemetry` 會：
   * 先檢核數值範圍；
   * 轉送給有訂閱的觀看者，壅塞時丟棄；
   * 交給 FlightRecorder（偵測起飛／落地，每秒批次寫入樣本與事件）；
   * 每 10 秒更新一次最後位置；
   * 每秒觸發一次 `telemetry` Webhook。
3. 指令：觀看者 → Hub（檢查角色、控制權、參數）→ 無人機 → ack → 廣播。每個指令都寫入稽核紀錄。
4. 影像：只在有觀看者時要求串流。每位觀看者的緩衝超過 1 MB 就丟棄影格，避免延遲累積。
5. 飛行結束：依序執行 AI 分析、合規檢查、`flight.ended`／`flight.analyzed`／`alert.raised` Webhook、日誌簿自動匯出。
6. 斷線：保留飛行紀錄一段寬限時間（`ATHENA_LINK_LOSS_GRACE_S`）。重新連線就繼續記錄，否則標記為 aborted。

## AI 飛行分析（`flights/analysis.ts`）

* **規則診斷**：振動（ArduPilot 慣用門檻：30／60 m/s²）、馬達輸出不平衡與飽和、每顆電芯的電壓驟降與最低電壓、落地剩餘電量、GNSS 衛星數與 HDOP、姿態震盪（高通 RMS）、最大傾角、觸地垂直速度、斷線、自駕儀錯誤、失效保護觸發。
* **個體基線異常偵測**：與同一台無人機最近 20 次飛行比較耗電率、平均電流、振動、馬達不平衡的 z-score（> 2.5 警告，> 4 嚴重），在故障發生前找出機械劣化。
* **健康分數**：100 減去扣分（嚴重 −25，警告 −8）。

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
