# Athena-sky

Athena-sky 是一套雲端無人機作業平台，功能對標 **Sky-Drones Cloud**：機隊管理、飛行表現監控、3D 任務規劃、透過 LTE 的即時控制與 HD 影像、飛行後 AI 分析、整合式 UTM（空域、地面危害、天氣、即時飛行授權），以及開放的 REST／WebSocket API。

> 功能逐項對照（含來源與測試）見 [docs/FEATURES.md](docs/FEATURES.md)，系統架構見 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，無人機與整合端的連線協定見 [docs/LINK_PROTOCOL.md](docs/LINK_PROTOCOL.md)。

## 功能一覽

| 模組 | 內容 |
|---|---|
| 帳號與團隊 | 註冊／登入／忘記密碼、組織與多組織切換、邀請成員、5 種角色（擁有者、管理員、任務經理、飛手、觀察員）、稽核紀錄 |
| Dashboard | 資產、使用者、飛行的關鍵指標；每日飛行次數與時數；最常用無人機、最有經驗飛手；AI 警示；可依時間區間與機隊篩選 |
| Drones & Operators | 無人機與飛手排行（次數、時數、距離、最長航時、健康分數）與重點摘要 |
| Flight Locations | 飛行位置與航跡地圖，標示合規狀態（法定高度、限航／禁航區、管制空域授權、地理圍欄） |
| Fleet Management | 即時在線狀態、韌體版本與遠端 OTA 更新、飛行時數、電池循環與健康度、下一個任務與沿線地形、在線飛手 |
| Flight Logs | LTE 即時記錄＋事後上傳（PX4 ULog `.ulg`、CSV、JSON）、AI 健康分數與機械異常偵測、任意欄位繪圖、CSV／KML／GPX／JSON 匯出、DroneLogbook 匯出、酬載資料與影像地理標記 |
| 3D Mission Planning | CesiumJS 3D 地形；點擊新增航點、拖曳調位置、Shift＋拖曳調高度；旋轉、傾斜、地表視角、正交俯視；集結點、地理圍欄、測繪掃描、任務統計與驗證；QGC `.plan`／`QGC WPL 110` 匯入匯出；上傳到無人機與排程 |
| Airspace & UTM | 空域區與地面危害（電線）、GeoJSON 匯入、天氣與可飛判定、圓柱與走廊飛行計畫的即時授權（自動核准或人工審核）、公開安全地圖；即時空域監控（接近／進入限航區、管制區未授權、電線、高度上限、機隊間隔、有人機交通）與通知中心 |
| Real-Time Flights | 地圖為主的操作台：3D／2D 地圖、右側多機影像（狀態、模式、剩餘航時）、快速指令、重新定位、事件紀錄；控制權鎖定、鍵盤與遊戲手把手動操控、端對端延遲、ADS-B 交通 |
| AI 視覺 | 即時影像上的人與車輛偵測（內建卷積網路模型，雲端 worker 執行）、多目標追蹤、顏色辨識、地面定位與速度、點選物體跟隨（Follow-me）；支援機上 AI 傳送偵測結果 |
| 群飛（Swarm） | 群組指令（同時起飛、懸停、返航、降落）；編隊或分割航線的群飛任務：預覽與間距檢查、同步起飛、航點屏障同步與配速、共同返航；飛手接手或故障時自動退出 |
| API 與整合 | OpenAPI 3（Swagger UI `/api/v2/docs/`）、個人 API Token、Live WebSocket、HMAC 簽章 Webhook（遙測與酬載串流、飛行、警示、授權、韌體、UTM 告警、群飛狀態） |

## 快速開始（示範模式）

需求：Node.js 22.13 以上。

```bash
npm install
npm run build
npm run demo          # http://localhost:8080
```

登入帳號：`demo@athena-sky.local`，密碼 `athena-demo`。

示範模式會建立一個組織，內含 4 位成員、2 個機隊、3 台虛擬無人機、30 天的飛行紀錄、任務、空域資料、排程與授權。虛擬無人機會透過真正的 Athena Link WebSocket 連線，所以起飛、影像、任務上傳、OTA 都能直接操作。其中 Heron-3 的馬達會逐漸劣化，用來展示 AI 異常偵測。

## 開發

```bash
npm run dev:server    # API + WebSocket，http://localhost:8080（tsx watch）
npm run dev:web       # Vite 開發伺服器，http://localhost:5173（/api 代理到 8080）
npm test              # 單元與整合測試（Vitest）
npm run test:e2e      # 端對端測試（Playwright，需先 npm run build）
npm run typecheck     # 全部套件的 TypeScript 型別檢查
npm run verify:ulog   # ULog 與 PX4 參考實作 pyulog 交叉驗證（需先 pip install pyulog）
```

開發模式下若瀏覽器與 API 不同源，請設定 `ATHENA_ALLOWED_ORIGINS=http://localhost:5173`，讓即時 WebSocket 通過來源檢查。

### 專案結構

```
packages/shared   共用型別、Athena Link／Live 協定、地理運算、任務格式（QGC .plan／WPL）、權限矩陣
apps/server       Fastify API、WebSocket 即時中樞、飛行記錄、ULog 解析、AI 分析、UTM、Webhook、SQLite
apps/web          React + Vite 網頁（Leaflet 2D 地圖、CesiumJS 3D 規劃器、uPlot 圖表）
apps/simulator    虛擬無人機（Athena Link 參考實作）：飛行物理、任務、失效保護、合成影像、ULog、OTA
e2e               Playwright 端對端測試
tools             驗證工具（ULog ↔ pyulog 交叉驗證）
```

## 連接真實無人機或模擬器

1. 到 **Fleet Management → Register drone** 註冊無人機，取得只顯示一次的連線金鑰（`adk_…`）。
2. 機上的通訊模組或伴隨電腦以 WebSocket 連到 `wss://<網域>/api/v2/link`，標頭帶 `Authorization: Bearer adk_…`。協定見 [docs/LINK_PROTOCOL.md](docs/LINK_PROTOCOL.md)。
3. 或用內建模擬器：

```bash
npm run simulator -- --url ws://localhost:8080/api/v2/link --key adk_xxx --lat 25.0732 --lon 121.5355 --adsb --payload
```

## 私有部署

```bash
cp .env.example .env              # 設定網域、SMTP、ATHENA_SECRET_KEY
docker compose up -d              # HTTP :8080，資料存在 athena-data volume
docker compose --profile tls up -d   # 加上 Caddy 自動 HTTPS／WSS（設定 ATHENA_DOMAIN）
```

所有資料都在一個 SQLite 檔案和資料目錄裡（`/data`）：資料庫、上傳的日誌、韌體、酬載影像、地形快取、加密金鑰。備份這個 volume 即可。

### 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT`／`HOST` | `8080`／`0.0.0.0` | 監聽位址 |
| `ATHENA_PUBLIC_URL` | `http://localhost:PORT` | 對外網址（用於郵件連結、韌體下載網址）。以 `https://` 開頭時 Cookie 會自動加上 Secure |
| `ATHENA_DATA_DIR` | `./data` | 資料目錄 |
| `ATHENA_SECRET_KEY` | 自動產生 | 32 位元組金鑰（64 個十六進位字元），以 AES-256-GCM 加密 Webhook 與整合服務的密鑰 |
| `SMTP_URL`／`MAIL_FROM` | 無 | 寄送邀請與重設密碼郵件。未設定時信件寫入 outbox 資料表與伺服器日誌 |
| `ATHENA_TERRAIN_URL` | AWS Terrain Tiles（Terrarium） | DEM 圖磚網址樣板，`off` 代表停用 |
| `ATHENA_WEATHER_URL` | Open-Meteo | 天氣 API，`off` 代表停用 |
| `ATHENA_GEOCODER_URL` | OpenStreetMap Nominatim | 反向地理編碼（規劃器顯示地名），`off` 代表停用。遵守其使用政策：每秒最多一次並快取 |
| `ATHENA_SAMPLE_HZ` | `2` | 即時飛行每秒寫入的遙測樣本數 |
| `ATHENA_LINK_LOSS_GRACE_S` | `60` | 斷線多久後結束飛行紀錄（標記為 aborted） |
| `ATHENA_TRUST_PROXY` | `0` | 部署在反向代理後面時設為 `1` |
| `ATHENA_ALLOWED_ORIGINS` | 無 | 額外允許的 WebSocket 來源（逗號分隔） |
| `ATHENA_ALLOW_PRIVATE_TARGETS` | `0` | 允許 Webhook 與日誌簿匯出連到內網位址。預設阻擋，防止 SSRF |
| `ATHENA_MAX_UPLOAD_MB` | `512` | 單一上傳檔案上限 |
| `ATHENA_DEMO` | `0` | 等同 `--demo` |
| `ATHENA_AIRSPACE_FEEDS` | （無） | 外部 GeoJSON 空域來源，JSON 陣列：`[{"id":"caa","name":"CAA UAS zones","url":"https://…/zones.geojson","refreshMinutes":60}]`。屬性 `name`、`type`、`floor`／`ceiling`（公尺）、`activeFrom`／`activeTo` |

## 安全性

* 密碼以 scrypt 雜湊。Session 使用 httpOnly Cookie，並以 CSRF 雙重提交保護狀態變更請求。
* API Token、無人機金鑰、重設密碼與邀請的 Token 都只儲存 SHA-256 雜湊值。Webhook 與整合服務的密鑰以 AES-256-GCM 加密儲存。
* 組織之間完全隔離：他組織的資源一律回傳 404。每個端點都依角色權限矩陣檢查。
* 瀏覽器的 WebSocket 會檢查 Origin。登入相關端點有速率限制。對外的 Webhook 與日誌簿匯出會阻擋內網位址（含 IPv4-mapped IPv6 等寫法），並在連線當下再檢查一次 DNS 解析結果，防止 SSRF 與 DNS rebinding。
* 即時連線（Live WebSocket）會跟著權限變動：成員被移除、角色降級、登出、Session 過期或 API Token 撤銷時，連線會立即關閉或降級，每個指令也會重新檢查角色。
* 網頁有 Content-Security-Policy（禁止 inline script 與事件屬性）。使用者提供的文字一律以純文字顯示；酬載影像只接受 JPEG／PNG／WebP／GIF／TIFF（依檔案內容判斷），並在 CSP sandbox 中提供。
* 上傳的 ULog 有欄位數與巢狀深度上限，惡意構造的檔案會被拒絕，不會耗盡記憶體。
* 正式環境請部署在 TLS 後面，讓 HTTPS／WSS 提供端對端加密。可用 compose 的 `tls` profile。

## 第三方服務說明

* 地圖底圖使用 OpenStreetMap 與 Esri World Imagery（2D），3D 地形使用 AWS Open Data Terrain Tiles。正式營運請依各服務的使用條款，或改用自有的圖磚服務（設定 `VITE_TILE_URL`、`ATHENA_TERRAIN_URL`）。
* Sky-Drones Cloud 串接的商業 UTM（Altitude Angel、AirMap、High Lander）與 DroneLogbook 需要各自的商業帳號，本專案沒有內建它們的專屬串接。空域資料來自組織自建區域與 `ATHENA_AIRSPACE_FEEDS` 設定的外部 GeoJSON 來源（`AirspaceProvider` 介面）；日誌簿匯出提供 JSON 與 multipart CSV 兩種通用格式（`LogbookProvider` 介面）。要接上特定商業服務，需另外實作對應的 provider。
