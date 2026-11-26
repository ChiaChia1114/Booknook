# Athena-sky 與 Sky-Drones Cloud 功能對照

本文件逐句對照 Sky-Drones 官方對 Sky-Drones Cloud 的功能描述與 Athena-sky 的實作，每一項都附上在 Athena-sky 裡的位置與驗證它的自動化測試。需求的細節與完整的測試追溯見 [FEATURES.md](FEATURES.md)。

## 來源

| 來源 | 取得結果（2026-11-23） |
|---|---|
| https://sky-drones.com/sky-drones-cloud（產品介紹頁） | HTTP 403：網站對自動化用戶端回應 Cloudflare 的「Just a moment…」機器人驗證頁，無法以程式讀取內容（2026-11-20 開發開始時相同）。不以任何方式繞過這個保護。 |
| https://docs.sky-drones.com/flight-operations/cloud（Sky-Drones 官方文件：Sky-Drones Cloud 總覽） | HTTP 200 |
| …/cloud/sign-up-and-log-in、dashboard、drones-and-operators、flight-locations、fleet-management、flight-logs、3d-mission-planning、integrated-utm、real-time-flights、api（官方文件的 10 個功能頁） | 全部 HTTP 200 |

官方文件（`https://docs.sky-drones.com/llms.txt` 的 Sky-Drones Cloud 章節）是 Sky-Drones 對同一個產品的功能說明：總覽與 10 個功能頁。介紹頁無法讀取，所以無法確認兩者內容完全相同；下表以官方文件為準，「官方描述」逐字引用這些頁面。

圖例：✅ 已實作並有自動化測試　◐ 部分符合，原因寫在該列並在表後說明：官方串接的特定商業服務與 Sky-Drones 自家硬體（Athena-sky 有同樣的流程與通用串接點，但沒有內建該服務或硬體的專屬連接器，要接上需另寫橋接服務或實作介面），以及沒有任何定位的日誌

## 總覽（flight-operations/cloud）

| 官方描述 | Athena-sky | 驗證 | |
|---|---|---|---|
| "Cloud-based web application for drone fleet management, performance monitoring, mission planning, real-time control, post-flight AI analytics" | 網頁應用程式（React）＋伺服器（Fastify、SQLite）：機隊管理（`/fleet`）、績效儀表板（`/`）、任務規劃（`/missions`）、即時控制（`/live`）、飛行後 AI 分析（飛行頁的 Post-flight analytics） | 以下各項；e2e 38 個情境 | ✅ |
| **Everything** – "Sky-Drones Cloud is the place for all data when working with and operating your fleet of drones. … A Sky-Drones centralized hub for all information is the key when getting drone workflow to the next level." | 單一組織空間：機隊、無人機、飛行、日誌檔、任務、排程、空域、授權、韌體、保養、報表、稽核紀錄（F11.1） | `lifecycle.test.ts`、`analytics-integrations.test.ts` | ✅ |
| **Integrated** – "Sky-Drones Cloud is tightly integrated with all hardware and software products including autopilots and SmartLinks. The data transmitted from the drone to the ground station is also available in the cloud." | Athena Link 協定（`docs/LINK_PROTOCOL.md`）：無人機以裝置金鑰連線，遙測、事件、任務、影像、酬載都送到雲端；參考實作 `apps/simulator`；PX4 ULog 與 CSV 日誌可匯入（F11.2）。沒有 Sky-Drones 自家自動駕駛儀與 SmartLink 的連接器，也沒有內建 MAVLink 連接器：第三方自動駕駛儀要即時連上，需要一個橋接程式（見表後說明） | `realtime.test.ts`、`lifecycle.test.ts` | ◐ |
| "Data can be synced either post-flight or during the flight with LTE connectivity." | 飛行中即時記錄（2 Hz 樣本、事件）；飛行後機上日誌同步 `POST /api/v2/link/logs` 與網頁上傳（ULog、CSV、JSON），自動附加到同一筆飛行（F11.3） | `flights.test.ts`、`lifecycle.test.ts`、`long-logs.test.ts` | ✅ |
| "Payload data gathering is integrated as well." | 酬載感測資料（`payload` 訊息）與酬載影像上傳、依航跡地理標記、Geotags CSV（F11.4） | `realtime.test.ts`、`flights.test.ts` | ✅ |
| **Everywhere** – "Cloud can be accessed from anywhere and anytime. Drone and operator can be at the flight location while mission managers can observe the flight sitting in a command center on the other side of the globe giving valuable advice and getting exactly what they need." | 網頁存取；任務經理與觀察員即時觀看（影像、遙測、通知），不能操控（F11.5、F9.5） | `realtime.test.ts`、e2e「F9c…」 | ✅ |

## 功能頁

| 官方頁面與描述 | Athena-sky | 驗證 | |
|---|---|---|---|
| **Sign up and Log in** – "To sign up and log in, go to http://cloud.sky-drones.com/ and create a new account." | `/signup`、`/login`（註冊時建立組織、Session Cookie＋CSRF、忘記密碼、邀請）（F1.1–F1.4） | `auth.test.ts`、e2e「F1…」「F1b…」 | ✅ |
| **Dashboard** – "provides all major information at a glance. General information about assets, users and flights allows you to quickly estimate fleet performance" | `/`：無人機、成員、飛手、飛行次數、飛行時數、距離、線上狀態、警示、每日圖表、Top drones／pilots（F2.1–F2.2）；期間與機隊篩選，自訂期間最長兩年，不能用的期間不套用並說明（F2.3–F2.4） | `analytics-integrations.test.ts`、e2e「F2/F3/F4…」、e2e「F2.3…」 | ✅ |
| Dashboard – "Filter over a certain period of time and within a specific fleet" | 日期區間與機隊篩選（F2.3–F2.4），另可自訂小工具版面（F2.5） | 同上、e2e「F2.5/F5.7/F6.8…」 | ✅ |
| **Drones and Operators** – "which drone is used the most? Who your most experienced pilot is? The pilot the highest number of flight hours in the team?" | `/analytics`（Drones & Operators）：最常用的無人機、最有經驗的飛手、飛行時數最高的飛手，排行表（F3.1–F3.2） | `analytics-integrations.test.ts`、e2e「F2/F3/F4…」 | ✅ |
| Drones and Operators – "just like Google Analytics... for Drones" | 依時間與機隊篩選、可排序的分析表（F3.3） | 同上 | ✅ |
| **Flight Locations** – "allows fleet managers to understand how vehicles are being used, ensures that all operations are compliant, and that they stay within the required regulations" | `/locations`：每趟飛行的起點與航跡，依合規結果上色；飛行後自動合規檢查（禁航／限航區、高度上限、地理圍欄、授權、他人保留空域）。統計涵蓋期間內的每一趟飛行；列表一次 2,000 趟（最新的在前），超過時標示「Showing … of …」並可載入更多（F4.1–F4.2） | `flights.test.ts`、`hardening.test.ts`、`long-logs.test.ts`、`analytics-integrations.test.ts`、e2e「F2/F3/F4…」 | ✅ |
| Flight Locations – "Filter for a certain period of time or specific fleet" | 期間、機隊、單一無人機與合規篩選（合規篩選在分頁之前，較舊的違規不會被較新的飛行擠掉）（F4.3） | `analytics-integrations.test.ts` | ✅ |
| **Fleet Management** – "keep track of all your assets within the company" | `/fleet`：機隊與無人機管理（序號、型號、機型、備註、移動機隊）（F5.1） | `lifecycle.test.ts`、e2e「F5…」「F5b…」 | ✅ |
| "Data is synchronized in real-time with drones using LTE networks." | Athena Link WebSocket 即時遙測（F5.2） | `realtime.test.ts` | ✅ |
| "Check for the currently installed software version on the vehicle and update remotely when necessary." | 韌體版本顯示；韌體套件上傳、遠端 OTA 更新、進度與驗證（F5.3） | `realtime.test.ts`、e2e「F5…」 | ✅ |
| "Interested in real-time flights? Use this page to see which drone and/or pilot is online now right now." | 線上無人機與飛手（F5.4） | `realtime.test.ts`、e2e「F5…」 | ✅ |
| "entire-fleet readings and status updates on one screen, with clear visuals as to where each drone has been, where its next mission is, and the type of terrain that will be encountered" | Fleet map 分頁：每台無人機最近飛行的航跡（7／30／90 天，每台最近 5 趟，依無人機上色，重新整理後仍在）、下一個排程任務的航線（虛線）、目前／最後位置與線上清單；無人機頁：最近 10 趟的航跡、下一個任務的航線小地圖與沿線地形剖面圖（地形與規劃高度、最小離地高度）（F5.5） | `analytics-integrations.test.ts`、`missions-airspace.test.ts`、e2e「F5…」 | ✅ |
| "flight hours, battery life, and real-time flights/flight logs provide the necessary information to maintain a vast fleet of drones" | 每台累計飛行時數、電池等效完整循環（各次飛行用掉的電量加總÷100）與由耗電趨勢估計的健康度、即時畫面與日誌連結；另有保養排程與預測性維修（F5.6–F5.8）。不追蹤個別電池組 | `maintenance.test.ts`、`realtime.test.ts`、e2e「F2.5/F5.7/F6.8…」 | ✅ |
| **Flight Logs** – "Every flight log is stored in the cloud and is accessible when you need it, no matter where you are in the world." | 所有飛行（即時記錄與上傳）連同原始日誌檔永久保存，可下載與匯出（CSV／KML／GPX／JSON）（F6.1、F6.6）。限制：完全沒有全球定位的日誌（沒有 GNSS 定位的桌上測試，或只靠光流、視覺定位的室內飛行）無法匯入——飛行以航跡儲存（地圖、合規、匯出），這類日誌會說明原因並拒絕（例如 PX4 官方 pyulog 測試資料夾中的 `sample.ulg` 等桌上測試日誌）；從未解鎖的日誌（桌上或模擬器測試）同樣拒絕，不算進飛行統計 | `flights.test.ts`、`long-logs.test.ts`、e2e「F6…」 | ◐ |
| "Detailed flight log analytics helps to ensure the best possible flight performance of your vehicle and detect potential mechanical issues before your customers or pilots become aware." | 飛行後 AI 分析：振動、馬達不平衡、電壓驟降、GNSS、姿態、重落地等，並與該機歷史比較找出異常（z-score）（F6.2）。PX4 日誌的馬達：v1.13 起的 `actuator_motors`；較舊日誌的 `actuator_outputs` 依機型（`MAV_TYPE`）只取多旋翼的馬達輸出（四軸 4、六軸 6、八軸 8 …），以日誌的 PWM 上下限換算，伺服、直通與未使用的輸出不列入；VTOL 與定翼機不評估馬達平衡 | `flights.test.ts`、`ulog-motors.test.ts`、`maintenance.test.ts` | ✅ |
| "create a detailed history of all historic, ongoing, and future drone operations" | 飛行列表（完成、進行中、匯入中）與任務排程（未來）（F6.3） | `realtime.test.ts`、`mission-upload.test.ts` | ✅ |
| "Constant flight log monitoring ensures safe and reliable operations for the whole fleet and for each individual drone/pilot." | 儀表板警示、無人機健康趨勢、Webhook `alert.raised`、預測性維修通知（F6.4） | `maintenance.test.ts`、`analytics-integrations.test.ts` | ✅ |
| **DroneLogbook Integration** – "Sky-Drones Cloud offers Dronelogbook integration for exporting the flight logs to our partner." | 日誌簿匯出連接器：端點、加密 API 金鑰、手動與自動匯出（F6.5） | `analytics-integrations.test.ts` | ◐ |
| **3D Mission Planning** – "Add waypoints interactively and view the flight plan from any perspective." | `/missions/:missionId`：CesiumJS 3D 規劃器，點擊地面新增航點（F7.1） | `mission.test.ts`、e2e「F7…」「F7b…」 | ✅ |
| "Rotate, change view angle, tilt, view from the surface, then get back to the orthogonal view again" | 相機工具列：旋轉、改變視角、傾斜、地表視角、回到正交俯視（F7.2） | e2e「F7…」 | ✅ |
| "Adjust waypoint position and altitude interactively" | 拖曳航點改位置、Shift＋拖曳改高度、側欄數值編輯（F7.3） | e2e「F7…」 | ✅ |
| **Integrated UTM** – "integrated Altitude Angel, AirMap, and High Lander UTM services" | 兩個串接點：空域資料（`AirspaceProvider`：組織自己的空域＋外部 GeoJSON 空域來源 `ATHENA_AIRSPACE_FEEDS`，來源狀態與問題清單）（F8.1），以及飛行授權（`FlightAuthority`：把申請送到外部 UTM 機關決定，`ATHENA_UTM_AUTHORITY_URL`，協定見 [UTM_AUTHORITY.md](UTM_AUTHORITY.md)）（F8.9） | `hardening.test.ts`、`utm.test.ts`、`utm-authority.test.ts`、e2e「F8d…」 | ◐ |
| "3D Terrain and Ground Hazards data … an intuitive 3D view … with interactive waypoints, all in the context of high-resolution World Terrain" | 3D 規劃器的世界地形（Cesium World Terrain 或 Terrarium DEM）、空域體積、電線與障礙物等地面危害（F8.2） | `missions-airspace.test.ts`、e2e「F7…」 | ✅ |
| "Terrain data is integrated with weather information and airspace data from Altitude Angel, helping pilots avoid ground hazards, manned flights, and other airspace restrictions." | 地形結合天氣（Open-Meteo：風、陣風、降水、能見度與可飛判定）與空域資料（組織自己的空域與外部 GeoJSON 空域來源；沒有 Altitude Angel 的連接器）：空域檢查、地面危害（F8.3、F8.4）。有人機交通只來自飛行中無人機機上的 ADS-B 接收器（即時顯示與警示，F8.8、F12.5），規劃時沒有有人機交通資料（見表後說明） | `missions-airspace.test.ts`、`utm.test.ts` | ◐ |
| "Sky-Drones Cloud supports real-time flight request and authorization with Altitude Angel. Find your intended flight area and submit a flight plan. This airspace will be reserved for you" | 授權申請 → 自動衝突檢查 →（設定外部機關時）以飛行計畫送到該機關，由它即時或稍後核准／駁回，撤銷與取消雙向同步；（未設定時）由 Athena-sky 立即核准、駁回或交任務經理審核。核准後保留空域（F8.5、F8.9） | `utm.test.ts`、`utm-authority.test.ts`、`hardening.test.ts`、e2e「F8…」「F8c…」 | ◐ |
| "this will be publicly available on Altitude Angel's online Drone Safety Map" | 外部機關核准的公開保留出現在該機關自己的安全地圖，申請上有連結（機關回傳的 `publicUrl`）；另有本伺服器的公開安全地圖 `/safety-map`（免登入）（F8.6、F8.9） | `utm-authority.test.ts`、e2e「F8…」 | ◐ |
| "Cylinder Flight Plan" / "Corridor Flight Plan" | 圓柱與走廊兩種飛行計畫，走廊可由任務航線產生（F8.7） | `utm.test.ts`、e2e「F8…」 | ✅ |
| **Real-Time Flights** – "Enjoy real-time LTE drone control and video streaming with Sky-Drones Cloud and SmartLink. Everything is web-based - you need only your login and password, no need to install any software whatsoever." | `/live` 主控台：瀏覽器內控制與影像，免安裝（F9.1）。無人機以 Athena Link 連上；沒有 SmartLink 的連接器（見表後說明） | `realtime.test.ts`、e2e「F9…」 | ◐ |
| "select the desired online vehicle, fly via LTE networks" | 線上載具清單與飛行指令（起飛、降落、返航、懸停、飛往、任務…）（F9.2） | `realtime.test.ts`、e2e「F9…」 | ✅ |
| "ultra-low latency flights over the internet without any additional software requirements" | 端到端延遲量測，影像背壓丟幀不累積延遲（F9.3） | `realtime.test.ts` | ✅ |
| "Fly right in your web browser with HD video alongside all major telemetry." | HD 影像（1280×720）與 HUD 遙測（F9.4） | `realtime.test.ts`、e2e「F9…」 | ✅ |
| "Operate multiple drones on a single page." | 同一頁多機格狀檢視，各自影像、遙測與控制（F9.5），另有群飛（F9.8） | `realtime.test.ts`、`swarm.test.ts`、e2e「F9.8…」 | ✅ |
| **Sky-Drones API** – "API reference: https://cloud.sky-drones.com/swagger/" | OpenAPI 規格 `/api/v2/schema`、Swagger UI `/api/v2/docs/`（`/swagger/` 轉址）、API Token（F10.1–F10.3） | `auth.test.ts`、e2e「F10/F12…」 | ✅ |

## 標示 ◐ 的項目（硬體整合與 SmartLink、Integrated UTM 的四列、DroneLogbook、沒有定位的日誌）

* **與自動駕駛儀和 SmartLink 緊密整合**（總覽的「Integrated」與 Real-Time Flights 的「with Sky-Drones Cloud and SmartLink」）：官方指的是 Sky-Drones 自家的產品（Smartap 自動駕駛儀、SmartLink 數據鏈），它們的通訊協定與硬體本專案無法取得。即時控制與影像（`/live`）對以 Athena Link 連上的無人機完整可用。Athena-sky 的無人機端以公開的 Athena Link 協定（`docs/LINK_PROTOCOL.md`，WebSocket＋JSON）連上雲端：遙測、事件、任務、指令、影像、酬載與飛行後日誌同步都走這個協定，參考實作是模擬器（`apps/simulator`）。飛行後的 PX4 ULog 與 CSV 日誌可直接上傳。本專案沒有內建 MAVLink 或 SmartLink 的連接器：要讓 PX4、ArduPilot 等第三方自動駕駛儀即時連上，需要一個在機上電腦或地面站執行、把它的協定（例如 MAVLink）轉成 Athena Link 的橋接程式。

* **Integrated UTM（Altitude Angel、AirMap、High Lander）**：這些是需要商業合約與 API 金鑰的外部服務，本專案沒有它們的帳號，也無法從這裡驗證它們的 API，所以沒有內建它們的專屬對接。Athena-sky 提供同樣的流程（空域資料、3D 空域體積、衝突檢查、即時飛行授權、空域保留、公開安全地圖、即時空域監控與通知），並有兩個串接點：
  * 空域資料：`AirspaceProvider`（`apps/server/src/airspace/providers.ts`），已實作 GeoJSON 空域來源；
  * 飛行授權與公開地圖：`FlightAuthority`（`apps/server/src/airspace/authority.ts`），已實作 HTTP/JSON 協定（[UTM_AUTHORITY.md](UTM_AUTHORITY.md)）：申請送出、等待決定、撤銷、取消、機關的公開地圖連結，並附參考實作 `apps/simulator/src/mock-authority.ts`（`athena-utm-authority`）。

  要接上一個 UTM 服務，需要寫一個把該協定轉成它的 API 的橋接服務，或實作上述介面（各需該服務的帳號與 API 文件）。地形結合「天氣與 Altitude Angel 空域資料」一列：天氣來自 Open-Meteo，空域來自組織自己的空域與 GeoJSON 空域來源；有人機交通只有飛行中無人機機上 ADS-B 接收器回報的即時資料（主控台顯示並發出警示），沒有服務端的有人機交通資料，規劃時也看不到。另外，官方列出的三個服務中有兩個已不再提供原本的服務：AirMap 在 2023 年 5 月底退出 LAANC 服務，並於 2023 年 6 月 22 日關閉 App（2021 年起屬於 DroneUp），Altitude Angel 在 2025 年 10 月 7 日進入破產管理（英國民航局 Skywise 公告 SW2025/341、SW2025/351），2026 年 1 月由 Indra 向破產管理人買下其 GuardianUTM 平台（含 Drone Assist）；High Lander（Vega UTM）仍在營運。
* **DroneLogbook Integration**：DroneLogbook 的匯入 API 格式沒有公開。Athena-sky 的日誌簿連接器（`LogbookProvider`）以 JSON 紀錄或 multipart CSV 上傳飛行紀錄，可設定端點與加密儲存的 API 金鑰，支援手動與自動匯出。
* **沒有定位的日誌**：Athena-sky 的飛行以航跡為核心（地圖、合規檢查、KML／GPX 匯出、熱度圖），完全沒有全球定位的日誌（桌上測試、只靠光流或視覺定位的室內飛行）目前不匯入，回應 400 並說明原因；有 GNSS 定位的日誌都會儲存，連同原始檔可隨時下載。

## 驗證方式

* 單元與整合測試：`npm test`（Vitest，29 個檔案、397 個測試）；端對端測試：`npm run test:e2e`（Playwright，38 個情境）。
* 第 19 輪由未參與開發的 agent 獨立審查（commit c4d5a21）：建置、型別檢查、全部測試與實際操作示範伺服器，結論 PASS。
* 第 20 輪由未參與開發的 agent 依官方文件逐句審查（自行讀取上方來源）：沒有重大問題，指出 4 項次要問題（舊版 PX4 日誌的馬達判讀、Flight Locations 的 2,000 筆上限、外部 UTM 授權串接點、機隊地圖的歷史與下一任務視覺）與 7 項小問題，均已修正。
* 第 21 輪（同樣自行讀取官方來源）：上述 4 項確認修正；新的外部 UTM 串接有 1 項重大問題（未結束的往來超過 200 筆時，之後的決定與撤銷不會套用）與 5 項次要問題（逾時後重送留下第二份計畫、改顯示名稱中斷往來、機關狀態跨組織可見、篩選後地圖不重新對焦、第三方 UTM 服務的說明不正確），以及 8 項小問題，均已修正。
* 第 22 輪：上述各項確認修正；指出 1 項重大問題（從上一版升級後，進行中的外部 UTM 往來不再追蹤，機關的撤銷因此遺失）與 4 項次要問題（處理較慢的機關在伺服器放棄後才建立的計畫沒有撤回、換機關網址但名稱相同時網頁仍顯示等待機關、地圖與「Load more」每分鐘被重設、FEATURES.md 的 ◐ 圖例），以及 6 項小問題，均已修正。
* 第 23 輪：沒有重大問題；上述各項確認修正（含實際從前一版升級、處理較慢的機關、跨分鐘的頁面行為），指出 4 項次要問題（前一版沒有答覆的送出在升級後立即取消時沒有撤回、已不再連接的機關的申請仍顯示「retrying」、清除自訂日期時頁面當掉、Flight Logs 換期間後停在原頁碼）與 5 項小問題，均已修正。
* 第 24 輪：沒有重大問題；上述各項確認修正（含實際升級與處理較慢的機關），指出 2 項次要問題（不支援依編號撤回的機關：計畫撤回後仍顯示「Not withdrawn yet … retrying」並重複查詢到時窗結束；組織駁回原本機關的申請時沒有註明計畫仍留在那裡）與 3 項小問題（逐位輸入年份時送出 0002 年等查詢、取消後仍顯示「等待決定」、從未解鎖的 PX4 日誌被當成飛行），均已修正。
* 第 25 輪：沒有重大問題；上述各項確認修正，指出 2 項次要問題（上一輪的日期修正讓年份無法逐位輸入；答覆遺失的申請在重送途中被取消時，網頁約 20 秒顯示舊的逾時錯誤）與 7 項小問題（操作後機關狀態沒有更新、前幾版留下的「等待決定」說明、AirMap 的日期、原本機關核准的申請沒有註明、Flight Logs 分頁參數沒有驗證、長日誌測試的停頓門檻），均已修正。
* 第 26 輪：沒有重大問題；上述各項確認修正（含實際升級舊資料、在瀏覽器逐位輸入年份），指出 3 項次要問題（回應很慢的機關在逾時後立刻收到重送、同時的呼叫超過 8 個；伺服器拒絕的自訂期間讓頁面留著另一個期間的結果；長日誌測試有兩個步驟在沒有分段處理時也不會失敗）與 7 項小問題（同一輪往來中撤回失敗的錯誤沒有記錄、升級後已取消申請顯示舊錯誤、稽核紀錄與其他整數查詢參數的驗證、「Submit request」可按兩次、原本機關的申請同時顯示「等待機關決定」與「改由組織決定」、Flight Logs 沒有「Importing」篩選、硬體整合一列標示過寬），均已修正（第 27 輪重新審查）。
* 第 27 輪：沒有重大問題；上述各項確認修正（含以另一個行程執行的機關量測同時呼叫數、以前兩版的資料實際升級、在瀏覽器逐位輸入年份與強制查詢失敗），指出 6 項次要問題（任務規劃器的授權申請可重複送出，且說明寫成一律立即核准；飛行樣本與 ULog 數列的整數參數沒有驗證；1970–2100 年以外的日期與清空的欄位沒有提示就不套用；一項分段處理測試在沒有分段時也會通過；同時最多 8 個呼叫的測試偶爾失敗、影像辨識測試在完整測試的負載下偶爾失敗，且成員的送出與取消不受 8 個的限制；不支援依編號撤回的機關若忽略查詢條件，會連其他業者的計畫一起撤回）與 6 項小問題（換篩選後仍顯示「Load more」的錯誤；Dashboard 保養小工具失敗時一直載入，總覽失敗時其他小工具也不顯示；答覆遺失後的提示；組織決定後仍留著原本機關的錯誤；兩列官方描述沒有逐字引用；同名的新舊機關分不出來），均已修正。影像辨識測試的不穩定：以模擬滿載重跑都通過，找到的可能原因是伺服器用影格分析完成時的姿態定位物體，已改為用拍攝當下的姿態。另外，所有需要等伺服器回應的按鈕都改為等待期間停用（第 28 輪重新審查）。
* 第 28 輪：沒有重大問題；上述各項確認修正（含以另一個行程的機關與計數代理量測同時呼叫數、在瀏覽器逐位輸入年份與強制每個請求失敗、在 4 核心滿載下量測影像定位），指出 1 項次要問題（透過共用函式呼叫伺服器的按鈕仍可連按：撤銷權杖與邀請、Webhook 的測試、暫停與刪除、預設保養計畫、刪除保養工作、儲存任務）與 6 項小問題（已結束的原本機關申請沒有寫出網址；換回之前的篩選時 Flight Locations 又出現舊的「Load more」錯誤與頁面；影格的姿態實際上從未內插；規劃器對話框在讀取中或讀不到時沒有說明由誰決定；追蹤時一個很慢的呼叫讓同一批的其他位置閒置；總覽三列與另外四列官方描述沒有逐字引用），均已修正：所有會建立或改變資料的按鈕都等待期間停用，刪除與撤銷類的按鈕一直停用到列表更新為止（第 29 輪重新審查）。
* 第 29 輪：沒有重大問題；上述各項確認修正（含官方 40 句引用逐句比對、以計數代理量測每個按鈕的請求數、在 4 核心滿載下量測影像定位、以另一個行程的機關量測同時連線數），指出 4 項次要問題（Flight Locations 換篩選、新篩選的第一頁還沒到時，舊篩選的「Load more」仍可按，會跳過新篩選的飛行；規劃器在儲存途中又修改的內容被顯示為「Saved」；追蹤時一頁最後一筆很慢的呼叫讓下一頁等著；群飛面板的群組起飛沒有確認，雙擊會送出兩次）與小問題（說明寫成機關不會同時收到超過 8 個呼叫，但伺服器放棄等待的呼叫不再計入；刪除空域區與重新分析失敗時沒有任何訊息，韌體部署全部失敗仍提示「Update scheduled for 0 drone(s)」；授權列表默默只列最近 500 筆；較舊的遙測晚到時會提早結束姿態等待），均已修正（第 30 輪重新審查）。
* 第 30 輪：沒有重大問題；上述各項確認修正（含以 230 個未結束往來量測跨頁追蹤、以另一個行程的機關量測連線數、在瀏覽器以延遲與失敗的回應操作 Flight Locations 與規劃器、遙測亂序時的影像定位），指出 2 項次要問題（Airspace 頁讀取失敗時顯示成「沒有資料」，「Show 500 more」失敗時連已列出的申請也消失；UTM_AUTHORITY.md 說伺服器同時開著的連線不超過 8 個，但閒置的 keep-alive 連線不在限制內）與 4 項小問題（極大的 `offset` 回應 500；「Show 500 more」載入期間提示消失並多顯示一列；提示對地圖內容的描述過寬；規劃器的「Request authorisation」用未儲存的航線申請），均已修正；另外全面檢查每個頁面，讀取失敗的資料都寫出原因而不是顯示成「沒有資料」，依讀取資料填寫的選單與表單在資料沒有載入時不會改掉已存的值（第 31 輪重新審查）。
* 第 31 輪：沒有重大問題；上述各項確認修正（含逐頁強制每個讀取請求失敗共 155 種情況、以 1,100 筆真實申請操作 Airspace 頁、在頂列切換組織），指出 7 項次要問題（通知中心、公開安全地圖、飛行頁的規劃航線、設定頁的組織讀取失敗時仍顯示成沒有資料或空白；切換組織後 Dashboard 顯示並存入上一個組織的版面；同一毫秒建立的申請排序不定讓一個測試偶爾失敗；說明寫得過寬）與 6 項小問題（三個頁面主要列表失敗時一直顯示載入中；登入狀態檢查失敗被當成登出；無人機對話框只在提示框寫出機隊讀取失敗；篩選在清單讀取失敗時仍可改掉選擇；地圖設定讀取失敗整個工作階段都記住、平面地形與群飛作業沒有說明；稽核紀錄與無人機頁的飛行表默默截斷），均已修正：切換組織時頁面重新開始，資料讀取失敗時各處寫出原因（第 32 輪重新審查）。
* 第 32 輪：沒有重大問題；上述各項確認修正（含逐頁強制每個讀取請求失敗共 140 種情況、22 個頁面同時全部失敗、在頂列切換組織、延遲上一個組織的回應），指出 4 項次要問題（切換組織時網址上選的無人機與即時主控台的「Vehicles」選擇沿用到新的組織；上一個組織晚到的組織設定與通知被套用到目前的組織，還可能存回上一個組織；無人機頁「all of them in Flight Logs」只開到最近 90 天；一台無人機的任務航線讀取失敗的提示被另一台之後讀到的航線清掉）與 3 項小問題（Dashboard 總覽與規劃器的任務讀取失敗時只寫原因、沒寫是哪一部分；稽核紀錄翻頁失敗後列表與翻頁消失；設定頁的組織與稽核紀錄讀取中是空白），均已修正：換組織時頁面與網址同時切換、網址上的選擇清除，上一頁／下一頁回到另一個組織的頁面時切回該組織，上一個組織晚到的組織設定與通知不再套用，Flight Logs 加上「All time」期間，設定頁各分頁讀取中顯示載入中（第 33 輪重新審查）。
* 第 33 輪：沒有重大問題；上述各項確認修正（含 17 個網址的切換組織檢查、延遲回應後來回切換、在資料剛到時快速離開頁面），指出 4 項次要問題（切換組織後新組織的即時主控台短暫顯示並查詢上一個組織的無人機；上一個組織晚完成的設定「Save」讓目前的組織一直顯示讀取中、規劃器暫以 120 m 檢查而沒有說明；切換前送出的上傳或新任務晚完成時在新組織開啟上一個組織的項目；說明寫得過寬）與 5 項小問題（被移出組織時網址保留上一個組織的無人機；選單連結或改選篩選後網址與篩選不一致；空域頁清除後晚到的「Check」與天氣仍顯示；即時主控台沒有頁面標題；自己另一個組織的項目連結顯示「not found」），均已修正：即時連線只交給目前選的組織，組織設定一律重新讀取目前選的組織，離開頁面後完成的動作不再開啟項目，網址與篩選保持一致，另一個組織的項目連結切換到該組織（第 34 輪重新審查）。
* 第 34 輪：沒有重大問題；上述各項確認修正（含每個動畫影格檢查切換組織後的主控台、晚完成的 Save、上傳、匯入與刪除、跨組織的上一頁與連結、被移出組織），指出 3 項次要問題（網址不再指定無人機或群飛面板時，即時主控台仍顯示先前網址的選擇；空域頁的「Check」沒有帶入表單選的無人機，與送出申請的判斷不同；說明寫成選單的「Flight Logs」回到預設篩選，實際只重設無人機與「All time」）與 4 項小問題（上傳中關閉對話框後結果沒有任何提示、列表不更新；對話框關閉後才完成的無人機註冊遺失一次性連線金鑰；開啟另一個組織的項目連結時先在原組織發出注定失敗的請求，最多查看 20 個組織沒有寫出；寫進網址的篩選讓分頁歷史紀錄很快填滿），均已修正：即時主控台的無人機與群飛面板完全跟著網址，「Check」帶入無人機，選單中目前頁面的連結重新開始該頁，對話框關閉後完成的結果另外顯示，被取代的歷史紀錄即時移除（第 35 輪重新審查）。
