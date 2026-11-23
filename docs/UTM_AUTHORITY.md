# 外部飛行授權機關（UTM）串接協定

Sky-Drones Cloud 把飛行授權交給 Altitude Angel 等 UTM 服務決定：「Find your intended flight area and submit a flight plan. This airspace will be reserved for you and this will be publicly available on Altitude Angel's online Drone Safety Map.」Athena-sky 用同樣的流程：伺服器設定一個外部飛行授權機關後，通過本地空域檢查的授權申請會以「飛行計畫」送到該機關，由它核准或拒絕；核准的公開保留會出現在它自己的無人機安全地圖上，網頁會連過去。

沒有設定外部機關時，行為與之前相同：沒有衝突的申請立即核准，管制空域內的申請由組織的任務經理核准，核准的公開保留只出現在本伺服器的 `/safety-map`。

> 本專案沒有內建 Altitude Angel、AirMap、High Lander 的專屬連接器（它們需要各自的商業帳號與 API 文件，從這裡也無法驗證）。其中兩個已不再提供原本的服務：AirMap 在 2023 年 6 月 22 日結束 LAANC 服務並關閉 App（2021 年起屬於 DroneUp）；Altitude Angel 在 2025 年 10 月 7 日進入破產管理（英國民航局 Skywise 公告 SW2025/341、SW2025/351），2026 年 1 月由 Indra 向破產管理人買下其 GuardianUTM 平台（含 Drone Assist）。High Lander（Vega UTM）仍在營運。要接上一個 UTM 服務，有兩種做法：寫一個小型「橋接服務」把下方協定轉成該服務的 API，或在伺服器實作 `FlightAuthority` 介面（`apps/server/src/airspace/authority.ts`）。`apps/simulator/src/mock-authority.ts` 是協定的參考實作，可以當橋接服務的範本。

## 設定

| 環境變數 | 說明 |
| --- | --- |
| `ATHENA_UTM_AUTHORITY_URL` | 機關的基底網址（http/https，不可含查詢字串、片段或帳密——金鑰放在 `_KEY`）。設定錯誤時伺服器不會啟動，避免默默改成本地決定。機關以這個網址（通訊協定、主機、連接埠與路徑）識別：換網址等於換了一個機關，原本機關進行中的申請改由組織自己決定（網頁顯示核准與駁回，並註明伺服器已不再連接原本的機關）。前一版以顯示名稱識別機關：升級後，名稱相同的往來在啟動時接手繼續追蹤（前一版沒有記錄送出與否，仍在送出或撤回中的視為已送出：取消時依申請編號撤回）。伺服器啟動約 1 秒後就先追蹤一輪 |
| `ATHENA_UTM_AUTHORITY_NAME` | 顯示名稱（預設 `External UTM`），例如 `High Lander bridge`。只用於顯示：改名後進行中的往來照常追蹤，顯示的名稱跟著更新 |
| `ATHENA_UTM_AUTHORITY_KEY` | 選用，以 `Authorization: Bearer <key>` 送出 |
| `ATHENA_UTM_AUTHORITY_POLL_S` | 追蹤未結束往來的間隔秒數（預設 15） |

`GET /api/v2/organisations/{orgId}/airspace/authority` 回傳目前的機關（名稱、網址的通訊協定與主機），以及這個組織自己等待決定的申請數、它的往來最後一次成功連線的時間與最後一次錯誤（其他組織的申請與錯誤看不到）。

## 流程

1. 申請先做本地檢查（空域區域、地面危害、其他業者的保留、組織的高度限制）。被本地檢查擋下的申請直接拒絕，**不會**送出。
2. 其餘申請以 `pending`（「Awaiting the flight authority's decision」）儲存，立即送出飛行計畫，並在回應裡帶回機關的第一個答覆（多數 UTM 服務是即時決定）：
   * `approved`：核准並保留空域（其他業者的重疊申請會被拒絕）；
   * `rejected`：拒絕，原因寫成「Rejected by <機關>: <原因>」；
   * `pending`：等待機關決定；伺服器每隔 `ATHENA_UTM_AUTHORITY_POLL_S` 秒查詢一次。

   每次追蹤都涵蓋**所有**未結束的往來（所有組織的；每次從資料庫讀 200 筆、同時最多 8 個呼叫，直到讀完）：重送還沒送到的、查詢等待中與已核准的（已核准的也要查，才知道機關是否撤銷）、撤回已取消的。上一輪還沒結束時不開始下一輪。
3. 由外部機關決定的申請，組織的任務經理**不能**自行核准或拒絕（409），但可以取消。
4. 取消申請時，飛行計畫會在機關那邊撤回（`DELETE`）；連不上時稍後重試，直到時窗結束後一天。
5. 機關之後撤銷已核准的申請（例如新的臨時限航），申請變成 `cancelled`，原因寫成「Withdrawn by <機關>: <原因>」，原本的核准時間保留（撤銷前飛的航班仍在授權範圍內）。
6. 時窗結束前機關都沒有決定：申請拒絕（「No decision from … before the window ended」），並在機關那邊撤回。
7. 機關核准時，如果這段期間其他業者已保留同一空域，或出現新的限制，這個核准不能使用：申請拒絕（「Approved by …, but …」）並在機關那邊撤回。
8. 連不上機關時，申請保持 `pending`，錯誤顯示在申請上與狀態端點，之後自動重送。
9. 送出沒有得到答覆（例如逾時）時，機關可能已經建立了計畫，或還在處理：重送用同一個申請編號，機關回傳已有的計畫，不會建立第二份（見下方「冪等」）。答覆遺失後申請被取消的，依申請編號撤回（`DELETE /flight-plans?reference=…`）：機關記住這個編號已撤回，之後才處理完的同編號送出直接成為撤回的計畫。機關不支援依編號撤回時（伺服器記住，不再重問），依編號查出計畫（`GET /flight-plans?reference=…`）撤回：找到並撤回就結束（冪等送出保證同一編號最多一份計畫）；還沒找到就在時窗結束前持續查詢（處理較慢的機關稍後才建立的計畫也撤得掉），期間申請顯示「Withdrawing its flight plan…」。
10. 換了機關網址後，原本機關的申請由組織決定或取消時，計畫仍留在原本的機關（伺服器已不再連接它）：網頁註明「its flight plan was not withdrawn there」，不顯示重試。

每次狀態改變都會發出 `authorization.updated` webhook、寫入稽核紀錄，並產生通知（核准是資訊，拒絕與撤銷是警告，也會送出 `utm.alert`）。

## 協定（HTTP/JSON）

所有呼叫 10 秒逾時，不跟隨轉址，答覆最多 64 KB。

### 送出飛行計畫：`POST {base}/flight-plans`

標頭 `Idempotency-Key: <reference>`。**冪等**：機關已經有同一個 `reference` 的計畫時，必須回傳那一份（200），不可再建立一份——沒有收到答覆的送出會以同一個內容再送一次。

```json
{
  "reference": "ATH-1A2B3C4D",
  "operator": { "organisation": "Acme Drones", "requestedBy": "Pat Pilot" },
  "drone": { "name": "Falcon-1", "serial": "SN-42" },
  "volume": { "kind": "cylinder", "center": { "lat": 25.0732, "lon": 121.5355 }, "radiusM": 300 },
  "geojson": { "type": "Feature", "geometry": { "type": "Polygon", "coordinates": [[[121.5355, 25.0759], "…"]] }, "properties": { "reference": "ATH-1A2B3C4D" } },
  "minAltM": 0,
  "maxAltM": 100,
  "altitudeReference": "takeoff",
  "startAt": "2026-11-23T09:00:00.000Z",
  "endAt": "2026-11-23T10:00:00.000Z",
  "public": true
}
```

`volume` 是圓柱（`cylinder`：中心與半徑）或走廊（`corridor`：`line` 折線與 `widthM` 寬度）；`geojson` 是同一個範圍的封閉多邊形（經度、緯度順序），給只收多邊形的服務。高度以起飛點為基準。

### 答覆（送出、查詢都相同）

```json
{ "id": "FP-9C1E22AB", "status": "approved", "reason": "No conflicting operations", "publicUrl": "https://utm.example/map#FP-9C1E22AB" }
```

* `status`：`approved`、`pending`、`rejected`、`cancelled`。也接受常見的同義字：`accepted`／`authorised`／`authorized`（核准）、`denied`／`declined`（拒絕）、`withdrawn`／`revoked`／`closed`（撤銷）、`submitted`／`received`／`in_review`（等待中）。其他值視為錯誤。
* `reason`：選用，最多保留 500 字。
* `publicUrl`：選用，機關公開地圖上這筆保留的網址；只接受 http/https，網頁以新分頁開啟。

### 查詢：`GET {base}/flight-plans/{id}`

答覆同上。404 視為機關已不再有這筆計畫（已核准的申請因此變成撤銷）。

### 依申請編號查詢：`GET {base}/flight-plans?reference={reference}`

答覆是陣列，元素同上（沒有時為空陣列；404 也視為沒有）。用於撤回一份送出時沒有收到答覆的計畫。

### 依申請編號撤回：`DELETE {base}/flight-plans?reference={reference}`

撤回所有這個編號的計畫，**並記住這個編號已撤回**：之後收到（或之後才處理完）的同編號送出，必須成為撤回（`cancelled`）的計畫，不可核准。即使目前沒有這個編號的計畫，也回應 2xx。回應 404、405 或 501 表示不支援，伺服器改用上一節的查詢逐一撤回。

### 撤回：`DELETE {base}/flight-plans/{id}`

2xx 或 404 都算完成。

## 參考實作（測試與示範）

```bash
npm run build                                                          # 也會建置 apps/simulator/dist/utm-authority.js
node apps/simulator/dist/utm-authority.js --port 4700 --mode review    # approve | review | reject
ATHENA_UTM_AUTHORITY_URL=http://127.0.0.1:4700 ATHENA_UTM_AUTHORITY_NAME="Mock UTM" npm run demo
```

* `approve`：120 m 以下立即核准，更高的拒絕；`review`：全部等待，在 `http://127.0.0.1:4700/` 的主控台按核准或拒絕（也可 `POST /flight-plans/{id}/decision`，內容 `{"status":"approved","reason":"…"}`）；`reject`：全部拒絕。
* `http://127.0.0.1:4700/map` 是它的「無人機安全地圖」，列出核准的公開計畫。
* `--key <金鑰>`：協定呼叫、主控台與決定都需要金鑰（`Authorization: Bearer <金鑰>`，或在主控台網址加 `?key=<金鑰>`）；公開地圖 `/map` 不需要。
* 它實作了冪等送出、依申請編號查詢與依申請編號撤回。
