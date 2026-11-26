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

雲端每 15 秒送一次 WebSocket ping；15 秒內沒有回應、也沒有送來任何訊息的連線會被終止（下行忙碌時 pong 可能排在後面，但無人機送來的任何訊息都表示連線還在）。

**時鐘**：收到 `hello` 後雲端立即、之後每 2 秒送一則 JSON `ping`（見 1.3；下行忙碌時略過那一次），無人機以 `pong` 回覆並附上自己時鐘的 `t`（與遙測 `t` 同一個時鐘）。雲端據此算出無人機時鐘比雲端快多少的**上界**：一次 `ping` 在雲端時間 `送出` 送出、無人機在自己時鐘 `t` 回覆、雲端在 `收到` 收到，表示差值介於 `t − 收到` 與 `t − 送出` 之間；雲端保留所有回覆中最小的上界（隨時間依兩個時鐘可能的漂移，每秒 0.5 ms，逐漸放寬；新的回覆顯示舊的上界已不成立——無人機的時鐘被調快——時改用新的）。用上界換算，無人機回報的時間（遙測的 `t`、影格的擷取時間、ADS-B 的回報時間）轉成雲端時鐘時**不會比實際晚**：上行（無人機 → 雲端）再慢、慢多久，資料都不會被當成比實際新——頂多因下行（雲端 → 無人機）的延遲而顯得舊一點。（取往返的中點如 NTP 的做法，上行與下行延遲不對稱時會差半個差值：慢的上行會讓資料看起來比實際新。）`hello` 附上 `t`（無人機送出 `hello` 時自己的時鐘）時，第一筆資料起就能換算（連線建立後無人機才能送出 `hello`，所以 `t` 減去雲端接受連線的時間就是一個上界）；沒有附的，第一次 `ping` 回來之前以雲端收到的時間代替。觀看者因此知道資料是多久以前的——無人機的時鐘沒有校準也一樣。

### 1.2 無人機 → 雲端

| type | 欄位 | 說明 |
|---|---|---|
| `hello` | `firmware`, `model?`, `serial?`, `capabilities{video,manualControl,adsb,ai}`, `camera?`, `mission?`, `t?` | 每次連線後送出。`t`（建議）：送出時無人機自己的時鐘（見 1.1 的時鐘）。`capabilities.ai`：機上有物件偵測（見下行 `ai` 與上行 `detections`）。韌體版本會即時同步到機隊頁面。`mission` 回報機上的任務（上傳時的 `missionId` 放在 `id`，加上目前項目 `seq` 與項目數 `total`），沒有任務時為 `null`：斷線重連或伺服器重新啟動後，雲端據此接回已載入的任務；回報的任務雲端不認得（期間被刪除，或由其他軟體上傳）時，會在事件紀錄提示，之後的飛行不掛任務。不送這個欄位的無人機，視為仍載著最後上傳的任務 |
| `telemetry` | `t, lat, lon, altMsl, altRel, heading, groundSpeed, climbRate, roll, pitch, yaw, battery{pct,voltage,current}, gps{fix,satellites,hdop}, mode, armed, inAir, link?, home?, missionSeq?, missionTotal?, wind?, vibration?, motors?` | 建議 5–10 Hz。`armed && inAir` 會自動開始飛行紀錄，`!armed` 或落地 20 秒後結束 |
| `event` | `level(info/warning/error/critical), code?, message` | 狀態文字。`error`／`critical` 會觸發 `alert.raised` Webhook |
| `ack` | `id, result(accepted/in_progress/completed/rejected/failed), message?` | 回覆 `command` |
| `mission_ack` | `id, result, message?` | 回覆 `mission_upload` |
| `mission_progress` | `seq, total` | 任務執行進度 |
| `firmware_progress` | `updateId, status(downloading/verifying/installing/completed/failed), progress, message?` | OTA 進度 |
| `adsb` | `aircraft[{icao, callsign?, lat, lon, altMsl, heading, speed, t}]` | 機上 ADS-B 接收器（例如 pingRX）回報目前追蹤的航機（建議每秒一次；範圍內沒有航機時送空的清單）。`t`：該航機最後一次被收到的時間（無人機的時鐘）。2 km、300 m 內的航機會產生交通警示事件 |
| `payload` | `kind, data{…}` | 酬載資料（感測器讀值、拍照紀錄），會附到進行中的飛行並觸發 `payload.data` Webhook |
| `detections` | `t?, objects[{cls(person/vehicle), score(0–1), box[left, top, width, height]}]` | 機上 AI 的偵測結果（方框為影像畫面的正規化座標 0–1，最多 100 個）。雲端依當下遙測與相機參數估算地面位置、追蹤並編號，主控台與 3D 視圖即時顯示，AI 跟隨也可以使用。收到後該機的 AI 來源顯示為「機上」，雲端不再另外分析影像。宣告 `capabilities.ai` 的無人機只在雲端以 `ai` 開啟後才回報（關閉後收到的回報不採用）；沒有宣告的無人機一送出就視為開啟 |
| `pong` | `id, t` | 回覆 `ping`（`id` 照抄），`t` 為無人機自己的時鐘：用來量測延遲與時鐘差 |

### 1.3 雲端 → 無人機

| type | 欄位 | 說明 |
|---|---|---|
| `welcome` | `droneId, name, serverTime` | 驗證成功 |
| `command` | `id, command, params` | `arm, disarm, takeoff{alt}, land, rtl, hold, goto{lat,lon,alt?}, set_mode{mode}, set_speed{speed}, mission_start{fromSeq?}, mission_pause, mission_resume, camera_photo, reboot`。請以 `ack` 回覆 |
| `mission_upload` | `id, missionId, name, plan` | `plan` 為 `MissionPlan`（items、rallyPoints、geofence、defaultSpeed、defaultAlt）。高度以 home 為基準 |
| `mission_clear` | `id, missionId` | 任務已飛到最後並降落：清除機上的這個任務（不是這個 `missionId`，或正在執行任務時不理會），之後 `hello` 回報 `mission: null`。要再飛一次就重新上傳 |
| `manual_control` | `x, y, z, r`（−1…1）, `t` | 手動控制（前進、右移、爬升、偏航），最高 50 Hz；下行忙碌（送往無人機的資料積壓超過 64 KB）時略過（下一筆會取代它）。超過 1 秒沒收到請懸停 |
| `video` | `action(start/stop), quality(sd/hd)` | 有觀看者時才要求串流，避免浪費 LTE 流量。最多每 0.5 秒送一次（觀看者來回切換時，送出那時要的畫質） |
| `ai` | `enabled` | 開關機上物件偵測（只送給宣告 `capabilities.ai` 的無人機）：飛手在主控台開啟 AI 時送出 `true`，關閉時送出 `false`；斷線重連時若仍開啟會再送一次 |
| `firmware_update` | `updateId, version, url, sha256, size` | 從一次性 URL 下載，驗證 SHA-256，安裝後重新連線並在 `hello` 回報新版本 |
| `ping` | `id, t` | 請立即回 `pong`（帶自己的時鐘 `t`）。雲端在 `hello` 之後與每 2 秒送一次（時鐘與往返時間）。觀看者的延遲量測不會轉送給無人機（雲端以自己量到的往返時間回答） |

### 1.4 影像訊框（二進位）
```
byte 0      0x01 (JPEG)
bytes 1..8  擷取時間（ms, float64 big-endian；與遙測的 `t` 同一個時鐘）
byte 9      串流編號（相機）
bytes 10..  JPEG（FF D8 …）
```
雲端只把影格轉送給有開啟影像的觀看者。觀看者的網路壅塞時會丟棄影格，讓延遲不會累積（回報收到訊息的觀看者依回報判斷壅塞，見 2.1 的 `ack`）。雲端 AI 依擷取時間找出拍攝當下的姿態（前後兩筆遙測內插；影格通常比它之後的那筆遙測先到，分析完會等拍攝時間當下或之後的那筆遙測，最多 0.5 秒——期間才到的較舊遙測不會結束等待；等不到時取一秒內最近的一筆），為偵測到的物體定位：影格分析得晚（傳輸、排隊、伺服器忙碌），轉向或移動中的無人機也不會把物體放錯位置。

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
| `ping` | `id, t, droneId?, late?`：雲端立即回 `pong`（附 `serverTime`，可用來估算與雲端時鐘的差與連線的往返時間）。有 `droneId` 時附上 `droneRttMs`：雲端到那台無人機的往返時間（雲端每 2 秒自己量一次；正在等回覆的那次等得更久時，至少是它已等的時間）——觀看者的 `ping` 不會轉送給無人機，瀏覽器到無人機的往返時間是自己量到的往返時間加上它。有 `late`（觀看者有一陣子沒收到遙測的無人機 id，最多 100 個）時附上 `dataAt`：雲端手上那幾台無人機最新一筆遙測的拍攝時間（雲端時鐘；還沒有遙測為 `null`）——比觀看者手上的新，就是觀看者自己的連線把資料擋住了，不是無人機 |
| `ack` | `n`：已收到這條連線的前 `n` 則訊息（文字與二進位訊框都算）。選用但建議送出（網頁版會送：連線後先送 `n: 0`，之後收到訊息時最多每 50 ms 送一次）。送過 `ack` 的觀看者有流量控制（`apps/server/src/realtime/flow.ts`）：雲端從回報學到連線最短的往返時間與送達速率，影像只在送出未回報的位元組不超過「往返時間內送得到的量，加上一小段排隊（以送達速率算 0.25 秒，最多 64 KB；至少一個影格）」時才送，並依送達速率稍快一點（1.25 倍）的節奏送出——不論連線慢或遠，排在觀看者前面的資料都只有零點幾秒。連線剛建立時，在途的量每個往返可以加倍，直到送達速率不再成長或開始排隊為止；有一陣子沒量到短的往返時間時，暫停影像直到佇列清空、重新量一次，排隊時間不會被當成連線本身的往返時間。某則訊息等待回報超過「往返時間加上它與它前面在途的資料以送達速率送完的時間（最多 2 秒），再加 0.5 秒」時，連線變慢或停頓：判定壅塞——影格丟棄，每台無人機只保留最新一筆遙測與偵測結果，等回報跟上再送出（送達速率也改用最近量到的）——其他訊息（狀態、事件、指令回覆、通知、`pong` 等）照常送出。往返時間沒有上限：遠的連線（衛星、跨洲）照樣收到全部遙測，只是晚了距離那麼久。這樣觀看者收到的資料不會因網路或系統緩衝區排隊而延遲累積（只看 socket 自己的緩衝看不到這些排隊）。沒有送 `ack` 的觀看者（較舊的整合）照舊：socket 的緩衝超過上限時才丟棄 |

### 2.2 雲端 → 用戶端
`hello`、`snapshot`（所有無人機狀態與在線使用者）、`status`、`telemetry`、`event`、`ack`、`control`、`flight`（started／ended；伺服器重新啟動後接續記錄的飛行也是 started）、`mission_progress`、`firmware_progress`、`adsb`、`users`、`pong`、`error`，以及：

| 訊息 | 欄位 | 說明 |
|---|---|---|
| `notification` | `notification{id, createdAt, level, category, code, droneId, droneName, title, message, data, resolvedAt}` | 通知中心的新通知（UTM 空域警示、維修到期、群飛狀態等）。組織的每位成員都會收到，內容與 `GET /organisations/:id/notifications` 相同；已讀狀態依使用者分開記錄 |
| `detections` | `droneId, t, objects[{trackId, cls, score, box, color, lat, lon, speedMs}]` | AI 物件偵測（雲端分析或機上 AI）：追蹤編號、類別、信心值、影像中的方框、主要顏色、估算的地面位置與速度 |
| `swarm` | `swarm{id, name, baseMissionId, options, state, message, members[…], createdBy, createdAt, updatedAt}` | 群飛作業的狀態變化（上傳、同步起飛、等待、各機進度、結束） |

`status` 的 `videoAvailable` 來自 `hello` 的 `capabilities.video`：沒有相機的無人機，主控台顯示「No camera on this drone」，也不會向它要求影像。

時間：轉給觀看者的時間都換算成雲端時鐘——`telemetry` 另有 `at`（樣本的拍攝時間；`data.t` 仍是無人機的時鐘），無人機狀態有 `telemetryAt`，影像訊框的擷取時間與 `adsb` 每架航機的 `t` 也是雲端時鐘（不會晚於實際的時間，也不會晚於雲端收到的時間，見 1.1 的時鐘；無人機的時鐘還不知道時，以雲端收到的時間代替）。觀看者以 `hello`／`pong` 的 `serverTime` 換算成自己的時鐘就能判斷資料是多久以前的；網頁版用與雲端相同的上界（`packages/shared/src/clock.ts`：`ping` 送出時的本機時間與 `pong` 的 `serverTime`），所以下行再慢也不會把舊資料當成新的。網頁版把超過 5 秒沒有新遙測的在線無人機標示為「no new data」（雲端也沒有更新的資料時，寫明是那台無人機的連線慢或停頓；雲端有較新的資料時，則是觀看者自己的連線延遲）、拍攝超過 3 秒的影格不當成即時影像（過期的那一刻就換掉，不必等其他資料進來），ADS-B 航機 15 秒沒有回報時標示為舊的（灰色，寫出最後回報時間），60 秒沒有回報時移除。

保護：一個觀看者每秒最多送 200 則訊息（瞬間最多 400 則），多的不處理；觀看者的 `ping` 不轉送給無人機；`video` 切換最多每 0.5 秒送給無人機一次；一台無人機最多 32 個指令在等它回覆，再多的指令會被拒絕（「… commands waiting for its answer」），等它回覆後才能再送；送往無人機的資料積壓時略過手動控制與時鐘 `ping`。任何成員（包括唯讀觀看者）都不能藉由大量訊息塞住無人機的控制連線。

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
