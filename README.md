# Athena-sky

Athena-sky 是一套雲端無人機作業平台，功能對標 **Sky-Drones Cloud**：機隊管理、飛行表現監控、3D 任務規劃、透過 LTE 的即時控制與 HD 影像、飛行後 AI 分析、整合式 UTM（空域、地面危害、天氣、即時飛行授權），以及開放的 REST／WebSocket API。

> 功能逐項對照（含來源與測試）見 [docs/FEATURES.md](docs/FEATURES.md)，系統架構見 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，無人機與整合端的連線協定見 [docs/LINK_PROTOCOL.md](docs/LINK_PROTOCOL.md)。

## 功能一覽

| 模組 | 內容 |
|---|---|
| 帳號與團隊 | 註冊／登入／忘記密碼、組織與多組織切換、邀請成員、5 種角色（擁有者、管理員、任務經理、飛手、觀察員）、稽核紀錄 |
| Dashboard | 可自訂的 widget 版面（顯示／隱藏／排序，依使用者儲存）：關鍵指標、依飛手與依無人機的飛行次數與時數、每日活動、飛行熱度圖、AI 趨勢與異常、維修狀態、AI 警示、最近飛行；可依時間區間與機隊篩選 |
| Drones & Operators | 無人機與飛手排行（次數、時數、距離、最長航時、健康分數）與重點摘要 |
| Flight Locations | 飛行位置與航跡地圖，標示合規狀態（法定高度、限航／禁航區、管制空域授權、地理圍欄） |
| Fleet Management | 即時在線狀態、韌體版本與遠端 OTA 更新、飛行時數、電池循環與健康度、下一個任務與沿線地形、在線飛手 |
| 維修 | 依飛行時數／次數／天數的保養排程、負責人、維修紀錄、到期與逾期通知；依飛行數據趨勢的預測性維修 |
| 報表 | 合規與績效報表（依期間、機隊、無人機、飛手；可選段落），預覽、CSV 匯出、可列印 HTML |
| Flight Logs | LTE 即時記錄＋事後上傳（PX4 ULog `.ulg`、CSV、JSON）、AI 健康分數與機械異常偵測、任務飛行的航線偏差分析（規劃與實際航跡對照）、任意欄位繪圖、CSV／KML／GPX／JSON 匯出、DroneLogbook 匯出、酬載資料與影像地理標記 |
| 3D Mission Planning | CesiumJS 3D 地形；點擊新增航點、拖曳調位置、Shift＋拖曳調高度；旋轉、傾斜、地表視角、正交俯視；集結點、地理圍欄、測繪掃描、任務統計與驗證；QGC `.plan`／`QGC WPL 110` 匯入匯出；上傳到無人機與排程 |
| Airspace & UTM | 空域區與地面危害（電線）、GeoJSON 匯入、天氣與可飛判定、圓柱與走廊飛行計畫的即時授權（自動核准或人工審核）、公開安全地圖；即時空域監控（接近／進入限航區、管制區未授權、電線、高度上限、機隊間隔、有人機交通）與通知中心 |
| Real-Time Flights | 地圖為主的操作台：3D／2D 地圖、右側多機影像（狀態、模式、剩餘航時）、快速指令、重新定位、事件紀錄；控制權鎖定、鍵盤與遊戲手把手動操控、端對端延遲、ADS-B 交通 |
| AI 視覺 | 即時影像上的人與車輛偵測（內建卷積網路模型，雲端 worker 執行）、多目標追蹤、顏色辨識、地面定位與速度、點選物體跟隨（Follow-me）；支援機上 AI 傳送偵測結果 |
| 群飛（Swarm） | 群組指令（同時起飛、懸停、返航、降落）；編隊或分割航線的群飛任務：預覽與間距檢查、同步起飛、航點屏障同步與配速、共同返航（各機先爬升到各自的返航高度、到齊後才一起飛回與降落，「全部返航」也一樣分層）；飛手接手或故障時自動退出 |
| API 與整合 | OpenAPI 3（Swagger UI `/api/v2/docs/`）、個人 API Token、Live WebSocket、HMAC 簽章 Webhook（遙測與酬載串流、飛行、警示、授權、韌體、UTM 告警、群飛狀態） |

## 快速開始（示範模式）

需求：Node.js 22.13 以上。

```bash
npm install
npm run build
npm run demo          # http://localhost:8080
```

登入帳號：`demo@athena-sky.local`，密碼 `athena-demo`。

示範模式會建立一個組織，內含 4 位成員、2 個機隊、3 台虛擬無人機、30 天的飛行紀錄、任務、空域資料、排程、授權與保養計畫（含即將到期與逾期的工作）。虛擬無人機會透過真正的 Athena Link WebSocket 連線，所以起飛、影像、任務上傳、OTA 都能直接操作。其中 Heron-3 的馬達會逐漸劣化，用來展示 AI 異常偵測。

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
apps/web          React + Vite 網頁（Leaflet 2D 地圖、CesiumJS 3D 規劃器、uPlot 圖表、lucide 圖示；深色／淺色主題）
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
# 相機拍到真實地點（衛星影像），人與車由機上 AI 偵測：
#   --imagery 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
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
| `SMTP_URL`／`MAIL_FROM` | 無 | 寄送邀請、註冊確認與重設密碼郵件。未設定時信件寫入 outbox 資料表與伺服器日誌（僅適合開發與示範環境） |
| `ATHENA_SIGNUP_CONFIRM_EMAIL` | 有設定 `SMTP_URL` 時為 `on` | 自行註冊須先點擊確認信中的連結（並輸入註冊時的密碼）才建立帳號，回應不會透露該 e-mail 是否已註冊。關閉時帳號立即建立，已註冊的 e-mail 會回報 409（有速率限制） |
| `ATHENA_TERRAIN_URL` | AWS Terrain Tiles（Terrarium） | DEM 圖磚網址樣板，`off` 代表停用 |
| `ATHENA_IMAGERY_URL` | Esri World Imagery | 衛星影像圖磚網址樣板（Web Mercator，`{z}/{x}/{y}`），`off` 代表停用。伺服器向它取圖並快取在資料目錄，提供給登入後頁面的衛星圖層與模擬無人機的相機（拍到真實地點）。伺服器需要能連到這台主機 |
| `ATHENA_IMAGERY_CACHE_MB` | `1024` | 衛星影像快取最多使用的磁碟空間（MiB）。超過時先刪最久沒用到的圖磚 |
| `ATHENA_TERRAIN_CACHE_MB` | `256` | 地形（DEM）快取最多使用的磁碟空間（MiB），規則同上 |
| `ATHENA_TILE_FETCHES_PER_HOUR` | `3600` | 每位使用者每小時最多讓伺服器向外部圖磚服務抓幾張圖（衛星影像與地形分開計算；已快取的圖磚不算），一次最多用掉一半。超過時回應 429 並附 `Retry-After`。`0` 代表不限制 |
| `ATHENA_API_REQUESTS_PER_S`／`ATHENA_API_REQUEST_BURST` | `20`／`300` | 每位成員（所有工作階段與 API 權杖合計）每秒、一次最多送幾個 API 請求；地圖與地形圖磚另計，是這個數字的十倍。超過的請求在 1 秒後才回應 429 並附 `Retry-After`，伺服器不替它做任何事。`0` 代表不限制 |
| `ATHENA_WEATHER_URL` | Open-Meteo | 天氣 API，`off` 代表停用 |
| `ATHENA_GEOCODER_URL` | OpenStreetMap Nominatim | 反向地理編碼（規劃器顯示地名），`off` 代表停用。遵守其使用政策：每秒最多一次並快取 |
| `ATHENA_SAMPLE_HZ` | `2` | 即時飛行每秒寫入的遙測樣本數 |
| `ATHENA_LINK_LOSS_GRACE_S` | `60` | 斷線多久後結束飛行紀錄（標記為 aborted）。伺服器重新啟動時，飛行中的無人機在這段時間內重新連線，就接續原本那筆飛行紀錄 |
| `ATHENA_TRUST_PROXY` | `0` | 部署在反向代理後面時設為 `1`：只相信本機或私有網段（例如 compose 的 Caddy）送來的 X-Forwarded-For。也可以改填代理的位址或 CIDR（逗號分隔） |
| `ATHENA_HTTP_PUBLISH` | `8080` | docker compose 對外開放應用程式的位址。放在 Caddy 後面時設為 `127.0.0.1:8080`，用戶端就無法繞過代理直接連線 |
| `ATHENA_ALLOWED_ORIGINS` | 無 | 額外允許的 WebSocket 來源（逗號分隔） |
| `ATHENA_ALLOW_PRIVATE_TARGETS` | `0` | 允許 Webhook 與日誌簿匯出連到內網位址。預設阻擋，防止 SSRF |
| `ATHENA_MAX_UPLOAD_MB` | `512` | 單一上傳檔案上限 |
| `ATHENA_DEMO` | `0` | 等同 `--demo` |
| `ATHENA_AIRSPACE_FEEDS` | （無） | 外部 GeoJSON 空域來源，JSON 陣列：`[{"id":"caa","name":"CAA UAS zones","url":"https://…/zones.geojson","refreshMinutes":60}]`。格式同下方「GeoJSON 空域」 |
| `ATHENA_UTM_AUTHORITY_URL` | （無） | 外部飛行授權機關（UTM 服務）：通過本地檢查的授權申請送到這裡決定，協定見 [docs/UTM_AUTHORITY.md](docs/UTM_AUTHORITY.md)。另有 `ATHENA_UTM_AUTHORITY_NAME`（顯示名稱）、`ATHENA_UTM_AUTHORITY_KEY`（Bearer 金鑰）、`ATHENA_UTM_AUTHORITY_POLL_S`（追蹤間隔，預設 15 秒）。參考實作：`node apps/simulator/dist/utm-authority.js --mode review` |

## GeoJSON 空域

空域頁的「Import GeoJSON」與 `ATHENA_AIRSPACE_FEEDS` 讀取 GeoJSON FeatureCollection：

* 幾何：`Polygon`（取外圈；內圈的洞不支援，區域會把洞一起涵蓋，偏向保守）、`MultiPolygon`（每個多邊形各成一個區域，名稱加上「(1/2)」等編號，最多 100 個）、`LineString`（屬性 `bufferM`，線兩側各幾公尺，預設 30）、`Point`（屬性 `radiusM`，半徑公尺，必填；也接受 `radius`、`radius_m`）。其他幾何會略過。
* 屬性：`name`（沒有看得見的字時用「Zone N」）、`type`（`ZONE_TYPES` 之一，否則用匯入時選的類型）、`floor`／`floorM`、`ceiling`／`ceilingM`（公尺，或帶單位的文字如 `400 ft`、`120 m`；`SFC`／`GND` 為地面，`UNL` 為無上限，`FL100` 等飛航空層換算成公尺並提出說明；寫反時區域取兩者之間；其他寫法提出說明並用預設值）、`activeFrom`／`activeTo`（ISO 8601：日期，或帶時區的日期時間，時區可寫 `Z`、`+08`、`+0800` 或 `+08:00`；結束不晚於開始的項目會略過，無法解讀的時間會忽略並提出說明）、`notes`。`LineString` 的緩衝至少 1 m；半徑與緩衝可寫公尺數字或帶單位的文字（`m`、`km`、`ft`、`NM`、`mi`）。整個在地面以下（上限不高於 0 m）、只有兩個不同角點或面積為 0 的多邊形會略過並說明。名稱最長 120 個字（不會切開表情符號）。
* 匯入結果會列出略過的每個項目與原因（`skipped`），以及經過簡化的項目（`warnings`，例如有洞的多邊形、寫反的上下限）；網頁在匯入欄下方列出全部。外部來源（`ATHENA_AIRSPACE_FEEDS`）的同樣內容在 `GET /api/v2/airspace/providers` 的 `issues`（略過與簡化各最多 40 筆），完整清單寫進伺服器紀錄。

## 安全性

* 密碼以 scrypt 雜湊。Session 使用 httpOnly Cookie，並以 CSRF 雙重提交保護狀態變更請求。
* API Token、無人機金鑰、重設密碼與邀請的 Token 都只儲存 SHA-256 雜湊值。Webhook 與整合服務的密鑰以 AES-256-GCM 加密儲存。
* 組織之間完全隔離：他組織的資源一律回傳 404。每個端點都依角色權限矩陣檢查。
* 瀏覽器的 WebSocket 會檢查 Origin。登入相關端點有速率限制。對外的 Webhook 與日誌簿匯出會阻擋內網位址（含 IPv4-mapped IPv6 等寫法）：儲存設定時就拒絕內網、本機與 `.local` 等位址，傳送當下再檢查一次 DNS 解析結果，防止 SSRF 與 DNS rebinding。
* 即時連線（Live WebSocket）會跟著權限變動：成員被移除、角色降級、登出、Session 過期或 API Token 撤銷時，連線會立即關閉或降級。每個送往無人機的指令都會以資料庫中「當下」的角色重新檢查，包括伺服器代為發出的指令（AI 跟隨、群飛同步）；操作者被降級或移除時，跟隨立即停止、群飛作業中止。
* 邀請：已有帳號的人也需要本人接受邀請才會加入組織，回應不透露該 e-mail 是否已註冊；同一個 e-mail 只有最新一封邀請有效，成員被移除時其未使用的邀請一併作廢。
* 註冊：有設定 SMTP 時（`ATHENA_SIGNUP_CONFIRM_EMAIL`），自行註冊要點擊確認信的連結並輸入註冊時設的密碼，才建立帳號：別人先用你的 e-mail 註冊時，你點到他那封信也不會建立他的帳號（他知道那個密碼），每次註冊各自保留自己的連結。不論 e-mail 是否已註冊，回應都相同；已註冊的人會收到一封說明信，內含登入與重設密碼連結。這時邀請連結也只寄到受邀者信箱，不會回傳給邀請人。
* 忘記密碼：不論帳號是否存在都立即回應相同內容，查詢與寄信在回應之後才進行，回應時間與郵件伺服器錯誤都不會透露帳號是否存在。
* 資料檔只有伺服器的使用者能讀寫：伺服器以 umask 077 執行，資料目錄（含既有的 volume）設為 0700，資料庫、金鑰、上傳的日誌與韌體為 0600。
* 外部空域資料來源的網址只顯示通訊協定與主機，不顯示可能含金鑰的路徑與查詢字串。
* 稽核紀錄記下每個人為下達的指令；伺服器代為發出的自動化指令（AI 跟隨的轉向、群飛同步）只記錄跟隨的開始／停止與群飛的各項操作，避免每秒一筆的雜訊。
* 網頁有 Content-Security-Policy（禁止 inline script 與事件屬性；CesiumJS 需要 `unsafe-eval`），所有頁面（含 API 參考與報表）都不允許被嵌入框架（`X-Frame-Options: DENY`）。CSV 匯出（飛行日誌與報表）會中和試算表公式。使用者提供的文字一律以純文字顯示；酬載影像只接受 JPEG／PNG／WebP／GIF／TIFF（依檔案內容判斷），並在 CSP sandbox 中提供。
* 上傳的 ULog 有欄位數、巢狀深度、主題訂閱數、格式欄位總數、資訊與參數筆數與解碼數值總數上限，CSV 有欄數上限，惡意構造的檔案會被拒絕，不會耗盡記憶體。每趟飛行最多 1,000,000 筆樣本（降採樣後）與 10,000 則日誌訊息；CSV 單行與 JSON 匯出檔的單一值不超過 1 MB。
* 長日誌與長飛行不會讓伺服器停頓：上傳的解析、樣本寫入（每 500 筆一個交易，寫入期間飛行為「匯入中」）、分析、合規檢查、樣本讀取、匯出、熱度圖、航跡預覽與刪除都分段進行，每段約 8 毫秒後讓其他請求（即時遙測、影像、指令）先處理。伺服器在匯入途中停止時，下次啟動會移除未完成的匯入，可以重新上傳。飛行後處理只讀取需要的欄位與分析用的樣本，合規檢查在紀錄之間補的點邊檢查邊產生（超過 100 m/s 的位置跳動不補），再長、再亂的日誌也不會耗盡記憶體。
* 正式環境請部署在 TLS 後面，讓 HTTPS／WSS 提供端對端加密。可用 compose 的 `tls` profile，並依 `.env.example` 設定 `ATHENA_HTTP_PUBLISH=127.0.0.1:8080`。登入的速率限制以用戶端位址計算，只採信代理送來的 X-Forwarded-For；直接連到應用程式的用戶端無法用這個標頭冒充其他位址。
* 刪除無人機或組織時，會一併刪除其飛行日誌與酬載影像檔案（組織還包括韌體檔）。無人機飛行中、飛行紀錄尚未結束時，不能刪除該無人機或其組織；日誌還在匯入中的飛行也不能刪除。

## 第三方服務說明

* 地圖底圖使用 OpenStreetMap 與 Esri World Imagery（2D），3D 地形使用 AWS Open Data Terrain Tiles。正式營運請依各服務的使用條款，或改用自有的圖磚服務（設定 `VITE_TILE_URL`、`ATHENA_TERRAIN_URL`）。
* 地圖影像由使用者的瀏覽器直接向圖磚伺服器取得，所以瀏覽器所在的網路（防火牆、Proxy）要能連到這些 HTTPS 主機：
  * 「Map」（2D 與 3D）：`tile.openstreetmap.org`（或 `VITE_TILE_URL` 指定的自有圖磚伺服器）。
  * 「Satellite」：伺服器有衛星影像快取（`ATHENA_IMAGERY_URL`，預設開啟）時，登入後的頁面向本伺服器取圖，瀏覽器不需要連到 Esri；公開的安全地圖與沒有快取時直接向 `server.arcgisonline.com` 取圖。沒有 Cesium ion token 時 3D 衛星圖同樣是 Esri；有 token 時 3D 改用 Bing Maps，需要 `api.cesium.com`、`assets.ion.cesium.com`、`dev.virtualearth.net`，以及 `ecn.t0.tiles.virtualearth.net` 到 `ecn.t3.tiles.virtualearth.net`。2D 衛星圖一律用 Esri。
  * 3D 地形與建物：有 token 時用 Cesium World Terrain 與 OSM Buildings（`api.cesium.com`、`assets.ion.cesium.com`）。沒有 token 時，地形由伺服器向 `ATHENA_TERRAIN_URL` 取得並快取，瀏覽器不需要對外連線。
* 圖磚一律以 HTTPS 載入（CSP 只允許 HTTPS）。在只有 HTTP 的部署上，Bing 衛星圖同樣走 HTTPS，所以 `VITE_TILE_URL` 也必須是 HTTPS 網址。
* 網站送出 `Referrer-Policy: strict-origin-when-cross-origin`：連到其他網站時只帶網站來源（例如 `https://drones.example.com/`），不帶路徑與查詢字串，連結裡的 token 不會外洩。OpenStreetMap 的使用政策要求網頁應用程式帶 Referer，不帶的請求只會拿到「Access blocked」圖磚。
* 瀏覽器連不到圖磚伺服器時，3D 視圖會顯示「map imagery unavailable」，滑鼠移上去可以看到是哪一台主機連不到。
* Sky-Drones Cloud 串接的商業 UTM（Altitude Angel、AirMap、High Lander）與 DroneLogbook 需要各自的商業帳號，本專案沒有內建它們的專屬連接器，也無法從這裡驗證它們的 API。其中 AirMap 已在 2023 年 5 月底退出 LAANC 服務、6 月 22 日關閉 App，Altitude Angel 已在 2025 年 10 月 7 日進入破產管理（2026 年 1 月由 Indra 買下其 GuardianUTM 平台）；High Lander 仍在營運。提供的通用串接點：空域資料來自組織自建區域與 `ATHENA_AIRSPACE_FEEDS` 設定的外部 GeoJSON 來源（`AirspaceProvider` 介面）；飛行授權可交給 `ATHENA_UTM_AUTHORITY_URL` 設定的外部機關決定（`FlightAuthority` 介面，HTTP/JSON 協定見 [docs/UTM_AUTHORITY.md](docs/UTM_AUTHORITY.md)，含送出飛行計畫、等待決定、撤銷、取消與機關公開地圖的連結）；日誌簿匯出提供 JSON 與 multipart CSV 兩種通用格式（`LogbookProvider` 介面）。要接上特定商業服務，需要一個把上述協定轉成該服務 API 的橋接服務，或實作對應的介面（各需該服務的帳號與 API 文件）。天氣來自 Open-Meteo；有人機交通只有飛行中無人機機上 ADS-B 接收器回報的即時資料。
* 無人機以 Athena Link 協定連上（[docs/LINK_PROTOCOL.md](docs/LINK_PROTOCOL.md)）。本專案沒有 Sky-Drones 自家自動駕駛儀與 SmartLink 數據鏈的連接器，也沒有內建 MAVLink 連接器：PX4、ArduPilot 等第三方自動駕駛儀要即時連上，需要把它們的協定轉成 Athena Link 的橋接程式；飛行後的 PX4 ULog 與 CSV 日誌可直接上傳。
