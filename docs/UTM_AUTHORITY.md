# 外部飛行授權機關（UTM）串接協定

Sky-Drones Cloud 把飛行授權交給 Altitude Angel 等 UTM 服務決定：「Find your intended flight area and submit a flight plan. This airspace will be reserved for you and this will be publicly available on Altitude Angel's online Drone Safety Map.」Athena-sky 用同樣的流程：伺服器設定一個外部飛行授權機關後，通過本地空域檢查的授權申請會以「飛行計畫」送到該機關，由它核准或拒絕；核准的公開保留會出現在它自己的無人機安全地圖上，網頁會連過去。

沒有設定外部機關時，行為與之前相同：沒有衝突的申請立即核准，管制空域內的申請由組織的任務經理核准，核准的公開保留只出現在本伺服器的 `/safety-map`。

> 本專案沒有內建 Altitude Angel、AirMap、High Lander 的專屬 API 對接（它們需要各自的商業合作帳號，從這裡也無法驗證）。要接上其中一個，有兩種做法：寫一個小型「橋接服務」把下方協定轉成該服務的 API，或在伺服器實作 `FlightAuthority` 介面（`apps/server/src/airspace/authority.ts`）。`apps/simulator/src/mock-authority.ts` 是協定的參考實作，可以當橋接服務的範本。

## 設定

| 環境變數 | 說明 |
| --- | --- |
| `ATHENA_UTM_AUTHORITY_URL` | 機關的基底網址（http/https）。設定錯誤時伺服器不會啟動，避免默默改成本地決定 |
| `ATHENA_UTM_AUTHORITY_NAME` | 顯示名稱（預設 `External UTM`），例如 `Altitude Angel` |
| `ATHENA_UTM_AUTHORITY_KEY` | 選用，以 `Authorization: Bearer <key>` 送出 |
| `ATHENA_UTM_AUTHORITY_POLL_S` | 追蹤未決申請的間隔秒數（預設 15） |

`GET /api/v2/airspace/authority` 回傳目前的機關（名稱、網址的通訊協定與主機、最後一次成功連線時間、最後一次錯誤、等待決定的申請數）。

## 流程

1. 申請先做本地檢查（空域區域、地面危害、其他業者的保留、組織的高度限制）。被本地檢查擋下的申請直接拒絕，**不會**送出。
2. 其餘申請以 `pending`（「Submitted to … – awaiting its decision」）儲存，立即送出飛行計畫，並在回應裡帶回機關的第一個答覆（多數 UTM 服務是即時決定）：
   * `approved`：核准並保留空域（其他業者的重疊申請會被拒絕）；
   * `rejected`：拒絕，原因寫成「Rejected by <機關>: <原因>」；
   * `pending`：等待機關決定；伺服器每隔 `ATHENA_UTM_AUTHORITY_POLL_S` 秒查詢一次。
3. 由外部機關決定的申請，組織的任務經理**不能**自行核准或拒絕（409），但可以取消。
4. 取消申請時，飛行計畫會在機關那邊撤回（`DELETE`）；連不上時稍後重試，直到時窗結束後一天。
5. 機關之後撤銷已核准的申請（例如新的臨時限航），申請變成 `cancelled`，原因寫成「Withdrawn by <機關>: <原因>」，原本的核准時間保留（撤銷前飛的航班仍在授權範圍內）。
6. 時窗結束前機關都沒有決定：申請拒絕（「No decision from … before the window ended」），並在機關那邊撤回。
7. 機關核准時，如果這段期間其他業者已保留同一空域，或出現新的限制，這個核准不能使用：申請拒絕（「Approved by …, but …」）並在機關那邊撤回。
8. 連不上機關時，申請保持 `pending`，錯誤顯示在申請上與狀態端點，之後自動重送。

每次狀態改變都會發出 `authorization.updated` webhook、寫入稽核紀錄，並產生通知（核准是資訊，拒絕與撤銷是警告，也會送出 `utm.alert`）。

## 協定（HTTP/JSON）

所有呼叫 10 秒逾時，不跟隨轉址，答覆最多 64 KB。

### 送出飛行計畫：`POST {base}/flight-plans`

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
* `--key <金鑰>` 要求協定呼叫帶 `Authorization: Bearer <金鑰>`。
