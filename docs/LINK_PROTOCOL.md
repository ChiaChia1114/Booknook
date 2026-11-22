# Athena Link／Athena Live 協定

Athena-sky 有兩條 WebSocket 通道：

* **Athena Link** `wss://<host>/api/v2/link`：無人機（LTE 通訊模組、伴隨電腦或地面站橋接程式）連線到雲端。
* **Athena Live** `wss://<host>/api/v2/live?org=<organisationId>`：瀏覽器或客戶系統連線，接收即時資料並控制無人機。

控制訊息是 JSON 文字訊框。影像是二進位訊框。型別定義在 `packages/shared/src/protocol.ts`，參考實作在 `apps/simulator/src/link-client.ts`。

---

## 1. Athena Link（無人機 ↔ 雲端）

### 1.1 驗證
連線時帶上標頭 `Authorization: Bearer adk_…`（註冊無人機時取得的連線金鑰）。無法設定標頭的裝置，可以在連線後 5 秒內送出第一則訊息 `{"type":"auth","key":"adk_…"}`。

| 關閉碼 | 意義 |
|---|---|
| 4401 | 未在時限內驗證 |
| 4403 | 金鑰無效（請勿自動重試） |
| 4409 | 同一台無人機的新連線取代了舊連線（例如 LTE 換手） |
| 4410 | 金鑰被輪替或無人機被刪除 |

雲端每 15 秒送一次 WebSocket ping，無回應的連線會被終止。

### 1.2 無人機 → 雲端

| type | 欄位 | 說明 |
|---|---|---|
| `hello` | `firmware`, `model?`, `serial?`, `capabilities{video,manualControl,adsb,ai}`, `camera?`, `mission?` | 每次連線後送出。`capabilities.ai`：機上有物件偵測（見下行 `ai` 與上行 `detections`）。韌體版本會即時同步到機隊頁面。`mission` 回報機上的任務（上傳時的 `missionId` 放在 `id`，加上目前項目 `seq` 與項目數 `total`），沒有任務時為 `null`：斷線重連或伺服器重新啟動後，雲端據此接回已載入的任務；回報的任務雲端不認得（期間被刪除，或由其他軟體上傳）時，會在事件紀錄提示，之後的飛行不掛任務。不送這個欄位的無人機，視為仍載著最後上傳的任務 |
| `telemetry` | `t, lat, lon, altMsl, altRel, heading, groundSpeed, climbRate, roll, pitch, yaw, battery{pct,voltage,current}, gps{fix,satellites,hdop}, mode, armed, inAir, link?, home?, missionSeq?, missionTotal?, wind?, vibration?, motors?` | 建議 5–10 Hz。`armed && inAir` 會自動開始飛行紀錄，`!armed` 或落地 20 秒後結束 |
| `event` | `level(info/warning/error/critical), code?, message` | 狀態文字。`error`／`critical` 會觸發 `alert.raised` Webhook |
| `ack` | `id, result(accepted/in_progress/completed/rejected/failed), message?` | 回覆 `command` |
| `mission_ack` | `id, result, message?` | 回覆 `mission_upload` |
| `mission_progress` | `seq, total` | 任務執行進度 |
| `firmware_progress` | `updateId, status(downloading/verifying/installing/completed/failed), progress, message?` | OTA 進度 |
| `adsb` | `aircraft[{icao, callsign?, lat, lon, altMsl, heading, speed, t}]` | 機上 ADS-B 接收器（例如 pingRX）。2 km、300 m 內的航機會產生交通警示事件 |
| `payload` | `kind, data{…}` | 酬載資料（感測器讀值、拍照紀錄），會附到進行中的飛行並觸發 `payload.data` Webhook |
| `detections` | `t?, objects[{cls(person/vehicle), score(0–1), box[left, top, width, height]}]` | 機上 AI 的偵測結果（方框為影像畫面的正規化座標 0–1，最多 100 個）。雲端依當下遙測與相機參數估算地面位置、追蹤並編號，主控台與 3D 視圖即時顯示，AI 跟隨也可以使用。收到後該機的 AI 來源顯示為「機上」，雲端不再另外分析影像。宣告 `capabilities.ai` 的無人機只在雲端以 `ai` 開啟後才回報（關閉後收到的回報不採用）；沒有宣告的無人機一送出就視為開啟 |
| `pong` | `id, t` | 回覆 `ping`，用來量測延遲 |

### 1.3 雲端 → 無人機

| type | 欄位 | 說明 |
|---|---|---|
| `welcome` | `droneId, name, serverTime` | 驗證成功 |
| `command` | `id, command, params` | `arm, disarm, takeoff{alt}, land, rtl, hold, goto{lat,lon,alt?}, set_mode{mode}, set_speed{speed}, mission_start{fromSeq?}, mission_pause, mission_resume, camera_photo, reboot`。請以 `ack` 回覆 |
| `mission_upload` | `id, missionId, name, plan` | `plan` 為 `MissionPlan`（items、rallyPoints、geofence、defaultSpeed、defaultAlt）。高度以 home 為基準 |
| `mission_clear` | `id, missionId` | 任務已飛到最後並降落：清除機上的這個任務（不是這個 `missionId`，或正在執行任務時不理會），之後 `hello` 回報 `mission: null`。要再飛一次就重新上傳 |
| `manual_control` | `x, y, z, r`（−1…1）, `t` | 手動控制（前進、右移、爬升、偏航），最高 50 Hz。超過 1 秒沒收到請懸停 |
| `video` | `action(start/stop), quality(sd/hd)` | 有觀看者時才要求串流，避免浪費 LTE 流量 |
| `ai` | `enabled` | 開關機上物件偵測（只送給宣告 `capabilities.ai` 的無人機）：飛手在主控台開啟 AI 時送出 `true`，關閉時送出 `false`；斷線重連時若仍開啟會再送一次 |
| `firmware_update` | `updateId, version, url, sha256, size` | 從一次性 URL 下載，驗證 SHA-256，安裝後重新連線並在 `hello` 回報新版本 |
| `ping` | `id, t` | 請回 `pong` |

### 1.4 影像訊框（二進位）
```
byte 0      0x01 (JPEG)
bytes 1..8  擷取時間（ms, float64 big-endian）
byte 9      串流編號（相機）
bytes 10..  JPEG（FF D8 …）
```
雲端只把影格轉送給有開啟影像的觀看者。觀看者的網路壅塞時會丟棄影格，讓延遲不會累積。

### 1.5 飛行後日誌同步（HTTP）
```
POST /api/v2/link/logs
Authorization: Bearer adk_…
Content-Type: application/octet-stream
X-Filename: log_2026-11-20.ulg
<.ulg / .csv 原始內容>
```
如果有時間重疊的即時飛行紀錄，日誌會附加到那筆紀錄（可在網頁以任意欄位繪圖）；沒有的話會建立新的飛行紀錄並執行分析。

---

## 2. Athena Live（瀏覽器／整合系統 ↔ 雲端）

驗證方式：瀏覽器用 Session Cookie（會檢查 Origin），整合系統用 `Authorization: Bearer ast_…`（個人 API Token）。需要具備 `live.view` 權限。

### 2.1 用戶端 → 雲端
| type | 欄位 |
|---|---|
| `subscribe` | `droneIds: string[] \| 'all'`（預設 `all`） |
| `video` | `droneId, enabled, quality?` |
| `command` | `droneId, requestId, command, params?` |
| `control` | `droneId, action(request/release/force)`：控制權鎖定，一台機一次只有一位控制者。`force` 需要 `drone.manage` |
| `manual_control` | `droneId, x, y, z, r`：只有控制者可以送 |
| `ping` | `id, t, droneId?`：有 `droneId` 時，量測瀏覽器 → 雲端 → 無人機的往返時間 |

### 2.2 雲端 → 用戶端
`hello`、`snapshot`（所有無人機狀態與在線使用者）、`status`、`telemetry`、`event`、`ack`、`control`、`flight`（started／ended；伺服器重新啟動後接續記錄的飛行也是 started）、`mission_progress`、`firmware_progress`、`adsb`、`users`、`pong`、`error`，以及：

| 訊息 | 欄位 | 說明 |
|---|---|---|
| `notification` | `notification{id, createdAt, level, category, code, droneId, droneName, title, message, data, resolvedAt}` | 通知中心的新通知（UTM 空域警示、維修到期、群飛狀態等），依接收者的角色與偏好篩選 |
| `detections` | `droneId, t, objects[{trackId, cls, score, box, color, lat, lon, speedMs}]` | AI 物件偵測（雲端分析或機上 AI）：追蹤編號、類別、信心值、影像中的方框、主要顏色、估算的地面位置與速度 |
| `swarm` | `swarm{id, name, baseMissionId, options, state, message, members[…], createdBy, createdAt, updatedAt}` | 群飛作業的狀態變化（上傳、同步起飛、等待、各機進度、結束） |

`status` 的 `videoAvailable` 來自 `hello` 的 `capabilities.video`：沒有相機的無人機，主控台顯示「No camera on this drone」，也不會向它要求影像。

二進位影像訊框：
```
byte 0                 0x01
byte 1                 droneId 長度 n
bytes 2..2+n           droneId（UTF-8）
next 8 bytes           擷取時間（float64 BE）
next 1 byte            串流編號
rest                   JPEG
```

---

## 3. Webhook
`POST` JSON `{ id, event, createdAt, organisationId, data }`，標頭：

* `X-Athena-Event`、`X-Athena-Delivery`、`X-Athena-Timestamp`
* `X-Athena-Signature: sha256=HMAC_SHA256(secret, "<timestamp>.<body>")`

事件：`drone.online`、`drone.offline`、`flight.started`、`flight.ended`、`flight.analyzed`、`telemetry`（每台機每秒一次）、`alert.raised`、`authorization.updated`、`firmware.updated`、`payload.data`、`utm.alert`（UTM 監控的通知，`data.notification`：闖入限制區、超過高度上限、與其他航空器或無人機距離過近等；只送 warning 與 critical 等級）、`swarm.updated`（群飛作業狀態變化，`data.swarm`）。

失敗會在 10 秒、1 分、5 分、30 分、2 小時後重試。`telemetry` 與 `payload.data` 是即時資料，失敗不重試。
