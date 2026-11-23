# Athena-sky 與 Sky-Drones Cloud 功能對照

本文件逐句對照 Sky-Drones 官方對 Sky-Drones Cloud 的功能描述與 Athena-sky 的實作，每一項都附上在 Athena-sky 裡的位置與驗證它的自動化測試。需求的細節與完整的測試追溯見 [FEATURES.md](FEATURES.md)。

## 來源

| 來源 | 取得結果（2026-11-23） |
|---|---|
| https://sky-drones.com/sky-drones-cloud（產品介紹頁） | HTTP 403：網站對自動化用戶端回應 Cloudflare 的「Just a moment…」機器人驗證頁，無法以程式讀取內容（2026-11-20 開發開始時相同）。不以任何方式繞過這個保護。 |
| https://docs.sky-drones.com/flight-operations/cloud（Sky-Drones 官方文件：Sky-Drones Cloud 總覽） | HTTP 200 |
| …/cloud/sign-up-and-log-in、dashboard、drones-and-operators、flight-locations、fleet-management、flight-logs、3d-mission-planning、integrated-utm、real-time-flights、api（官方文件的 10 個功能頁） | 全部 HTTP 200 |

官方文件（`https://docs.sky-drones.com/llms.txt` 的 Sky-Drones Cloud 章節）就是同一個產品的功能說明，與介紹頁的功能分類相同：總覽與 10 個功能頁。下表的「官方描述」逐字引用這些頁面。

圖例：✅ 已實作並有自動化測試　◐ 已實作同一功能，但官方是串接特定商業服務，需該服務的合約或 API 金鑰才能直接連接（原因見表後說明）

## 總覽（flight-operations/cloud）

| 官方描述 | Athena-sky | 驗證 | |
|---|---|---|---|
| "Cloud-based web application for drone fleet management, performance monitoring, mission planning, real-time control, post-flight AI analytics" | 網頁應用程式（React）＋伺服器（Fastify、SQLite）：機隊管理（`/fleet`）、績效儀表板（`/`）、任務規劃（`/missions`）、即時控制（`/live`）、飛行後 AI 分析（飛行頁的 Post-flight analytics） | 以下各項；e2e 29 個情境 | ✅ |
| "Everything – Sky-Drones Cloud is the place for all data when working with and operating your fleet of drones … A Sky-Drones centralized hub for all information" | 單一組織空間：機隊、無人機、飛行、日誌檔、任務、排程、空域、授權、韌體、保養、報表、稽核紀錄（F11.1） | `lifecycle.test.ts`、`analytics-integrations.test.ts` | ✅ |
| "Integrated – tightly integrated with all hardware and software products including autopilots and SmartLinks. The data transmitted from the drone to the ground station is also available in the cloud." | Athena Link 協定（`docs/LINK_PROTOCOL.md`）：無人機以裝置金鑰連線，遙測、事件、任務、影像、酬載都送到雲端；參考實作 `apps/simulator`（F11.2） | `realtime.test.ts`、`lifecycle.test.ts` | ✅ |
| "Data can be synced either post-flight or during the flight with LTE connectivity." | 飛行中即時記錄（2 Hz 樣本、事件）；飛行後機上日誌同步 `POST /api/v2/link/logs` 與網頁上傳（ULog、CSV、JSON），自動附加到同一筆飛行（F11.3） | `flights.test.ts`、`lifecycle.test.ts`、`long-logs.test.ts` | ✅ |
| "Payload data gathering is integrated as well." | 酬載感測資料（`payload` 訊息）與酬載影像上傳、依航跡地理標記、Geotags CSV（F11.4） | `realtime.test.ts`、`flights.test.ts` | ✅ |
| "Everywhere – Cloud can be accessed from anywhere and anytime … mission managers can observe the flight sitting in a command center on the other side of the globe giving valuable advice" | 網頁存取；任務經理與觀察員即時觀看（影像、遙測、通知），不能操控（F11.5、F9.5） | `realtime.test.ts`、e2e「F9c…」 | ✅ |

## 功能頁

| 官方頁面與描述 | Athena-sky | 驗證 | |
|---|---|---|---|
| **Sign up and Log in** – "go to cloud.sky-drones.com and create a new account" | `/signup`、`/login`（註冊時建立組織、Session Cookie＋CSRF、忘記密碼、邀請）（F1.1–F1.4） | `auth.test.ts`、e2e「F1…」「F1b…」 | ✅ |
| **Dashboard** – "provides all major information at a glance. General information about assets, users and flights allows you to quickly estimate fleet performance" | `/`：無人機、成員、飛手、飛行次數、飛行時數、距離、線上狀態、警示、每日圖表、Top drones／pilots（F2.1–F2.2） | `analytics-integrations.test.ts`、e2e「F2/F3/F4…」 | ✅ |
| Dashboard – "Filter over a certain period of time and within a specific fleet" | 日期區間與機隊篩選（F2.3–F2.4），另可自訂小工具版面（F2.5） | 同上、e2e「F2.5/F5.7/F6.8…」 | ✅ |
| **Drones and Operators** – "which drone is used the most? Who your most experienced pilot is? The pilot the highest number of flight hours in the team?" | `/analytics`（Drones & Operators）：最常用的無人機、最有經驗的飛手、飛行時數最高的飛手，排行表（F3.1–F3.2） | `analytics-integrations.test.ts`、e2e「F2/F3/F4…」 | ✅ |
| Drones and Operators – "just like Google Analytics... for Drones" | 依時間與機隊篩選、可排序的分析表（F3.3） | 同上 | ✅ |
| **Flight Locations** – "allows fleet managers to understand how vehicles are being used, ensures that all operations are compliant, and that they stay within the required regulations" | `/locations`：每趟飛行的起點與航跡，依合規結果上色；飛行後自動合規檢查（禁航／限航區、高度上限、地理圍欄、授權、他人保留空域）。統計涵蓋期間內的每一趟飛行；列表一次 2,000 趟（最新的在前），超過時標示「Showing … of …」並可載入更多（F4.1–F4.2） | `flights.test.ts`、`hardening.test.ts`、`long-logs.test.ts`、`analytics-integrations.test.ts`、e2e「F2/F3/F4…」 | ✅ |
| Flight Locations – "Filter for a certain period of time or specific fleet" | 期間、機隊、單一無人機與合規篩選（合規篩選在分頁之前，較舊的違規不會被較新的飛行擠掉）（F4.3） | `analytics-integrations.test.ts` | ✅ |
| **Fleet Management** – "keep track of all your assets within the company" | `/fleet`：機隊與無人機管理（序號、型號、機型、備註、移動機隊）（F5.1） | `lifecycle.test.ts`、e2e「F5…」「F5b…」 | ✅ |
| "Data is synchronized in real-time with drones using LTE networks." | Athena Link WebSocket 即時遙測（F5.2） | `realtime.test.ts` | ✅ |
| "Check for the currently installed software version on the vehicle and update remotely when necessary." | 韌體版本顯示；韌體套件上傳、遠端 OTA 更新、進度與驗證（F5.3） | `realtime.test.ts`、e2e「F5…」 | ✅ |
| "use this page to see which drone and/or pilot is online now right now" | 線上無人機與飛手（F5.4） | `realtime.test.ts`、e2e「F5…」 | ✅ |
| "entire-fleet readings and status updates on one screen, with clear visuals as to where each drone has been, where its next mission is, and the type of terrain that will be encountered" | Fleet map 分頁：每台無人機最近飛行的航跡（7／30／90 天，每台最近 5 趟，依無人機上色，重新整理後仍在）、下一個排程任務的航線（虛線）、目前／最後位置與線上清單；無人機頁：最近 10 趟的航跡、下一個任務的航線小地圖與沿線地形剖面圖（地形與規劃高度、最小離地高度）（F5.5） | `analytics-integrations.test.ts`、`missions-airspace.test.ts`、e2e「F5…」 | ✅ |
| "flight hours, battery life, and real-time flights/flight logs provide the necessary information to maintain a vast fleet of drones" | 每台累計飛行時數、電池等效完整循環（各次飛行用掉的電量加總÷100）與由耗電趨勢估計的健康度、即時畫面與日誌連結；另有保養排程與預測性維修（F5.6–F5.8）。不追蹤個別電池組 | `maintenance.test.ts`、`realtime.test.ts`、e2e「F2.5/F5.7/F6.8…」 | ✅ |
| **Flight Logs** – "Every flight log is stored in the cloud and is accessible when you need it, no matter where you are in the world." | 所有飛行（即時記錄與上傳）連同原始日誌檔永久保存，可下載與匯出（CSV／KML／GPX／JSON）（F6.1、F6.6）。沒有任何定位的日誌（例如沒有 GNSS 定位的桌上測試）不是飛行，會說明原因並拒絕匯入 | `flights.test.ts`、`long-logs.test.ts`、e2e「F6…」 | ✅ |
| "Detailed flight log analytics helps to ensure the best possible flight performance of your vehicle and detect potential mechanical issues before your customers or pilots become aware." | 飛行後 AI 分析：振動、馬達不平衡、電壓驟降、GNSS、姿態、重落地等，並與該機歷史比較找出異常（z-score）（F6.2）。PX4 日誌的馬達：v1.13 起的 `actuator_motors`；較舊日誌的 `actuator_outputs` 依機型（`MAV_TYPE`）只取多旋翼的馬達輸出（四軸 4、六軸 6、八軸 8 …），以日誌的 PWM 上下限換算，伺服、直通與未使用的輸出不列入；VTOL 與定翼機不評估馬達平衡 | `flights.test.ts`、`ulog-motors.test.ts`、`maintenance.test.ts` | ✅ |
| "create a detailed history of all historic, ongoing, and future drone operations" | 飛行列表（完成、進行中、匯入中）與任務排程（未來）（F6.3） | `realtime.test.ts`、`mission-upload.test.ts` | ✅ |
| "Constant flight log monitoring ensures safe and reliable operations for the whole fleet and for each individual drone/pilot." | 儀表板警示、無人機健康趨勢、Webhook `alert.raised`、預測性維修通知（F6.4） | `maintenance.test.ts`、`analytics-integrations.test.ts` | ✅ |
| "DroneLogbook Integration – exporting the flight logs to our partner" | 日誌簿匯出連接器：端點、加密 API 金鑰、手動與自動匯出（F6.5） | `analytics-integrations.test.ts` | ◐ |
| **3D Mission Planning** – "Add waypoints interactively and view the flight plan from any perspective." | `/missions/:missionId`：CesiumJS 3D 規劃器，點擊地面新增航點（F7.1） | `mission.test.ts`、e2e「F7…」「F7b…」 | ✅ |
| "Rotate, change view angle, tilt, view from the surface, then get back to the orthogonal view again" | 相機工具列：旋轉、改變視角、傾斜、地表視角、回到正交俯視（F7.2） | e2e「F7…」 | ✅ |
| "Adjust waypoint position and altitude interactively" | 拖曳航點改位置、Shift＋拖曳改高度、側欄數值編輯（F7.3） | e2e「F7…」 | ✅ |
| **Integrated UTM** – "integrated Altitude Angel, AirMap, and High Lander UTM services" | 兩個串接點：空域資料（`AirspaceProvider`：組織自己的空域＋外部 GeoJSON 空域來源 `ATHENA_AIRSPACE_FEEDS`，來源狀態與問題清單）（F8.1），以及飛行授權（`FlightAuthority`：把申請送到外部 UTM 機關決定，`ATHENA_UTM_AUTHORITY_URL`，協定見 [UTM_AUTHORITY.md](UTM_AUTHORITY.md)）（F8.9） | `hardening.test.ts`、`utm.test.ts`、`utm-authority.test.ts`、e2e「F8d…」 | ◐ |
| "3D Terrain and Ground Hazards data … an intuitive 3D view … with interactive waypoints, all in the context of high-resolution World Terrain" | 3D 規劃器的世界地形（Cesium World Terrain 或 Terrarium DEM）、空域體積、電線與障礙物等地面危害（F8.2） | `missions-airspace.test.ts`、e2e「F7…」 | ✅ |
| "Terrain data is integrated with weather information and airspace data … helping pilots avoid ground hazards, manned flights, and other airspace restrictions" | 天氣（風、陣風、降水、能見度與可飛判定）、空域檢查、有人機交通（ADS-B）（F8.3、F8.4、F8.8、F12.5） | `missions-airspace.test.ts`、`utm.test.ts` | ✅ |
| "Sky-Drones Cloud supports real-time flight request and authorization with Altitude Angel. Find your intended flight area and submit a flight plan. This airspace will be reserved for you" | 授權申請 → 自動衝突檢查 →（設定外部機關時）以飛行計畫送到該機關，由它即時或稍後核准／駁回，撤銷與取消雙向同步；（未設定時）由 Athena-sky 立即核准、駁回或交任務經理審核。核准後保留空域（F8.5、F8.9） | `utm.test.ts`、`utm-authority.test.ts`、`hardening.test.ts`、e2e「F8…」「F8c…」 | ◐ |
| "this will be publicly available on Altitude Angel's online Drone Safety Map" | 外部機關核准的公開保留出現在該機關自己的安全地圖，申請上有連結（機關回傳的 `publicUrl`）；另有本伺服器的公開安全地圖 `/safety-map`（免登入）（F8.6、F8.9） | `utm-authority.test.ts`、e2e「F8…」 | ◐ |
| "Cylinder Flight Plan" / "Corridor Flight Plan" | 圓柱與走廊兩種飛行計畫，走廊可由任務航線產生（F8.7） | `utm.test.ts`、e2e「F8…」 | ✅ |
| **Real-Time Flights** – "real-time LTE drone control and video streaming … Everything is web-based – you need only your login and password, no need to install any software" | `/live` 主控台：瀏覽器內控制與影像，免安裝（F9.1） | `realtime.test.ts`、e2e「F9…」 | ✅ |
| "select the desired online vehicle, fly via LTE networks" | 線上載具清單與飛行指令（起飛、降落、返航、懸停、飛往、任務…）（F9.2） | `realtime.test.ts`、e2e「F9…」 | ✅ |
| "ultra-low latency flights over the internet without any additional software requirements" | 端到端延遲量測，影像背壓丟幀不累積延遲（F9.3） | `realtime.test.ts` | ✅ |
| "Fly right in your web browser with HD video alongside all major telemetry." | HD 影像（1280×720）與 HUD 遙測（F9.4） | `realtime.test.ts`、e2e「F9…」 | ✅ |
| "Operate multiple drones on a single page." | 同一頁多機格狀檢視，各自影像、遙測與控制（F9.5），另有群飛（F9.8） | `realtime.test.ts`、`swarm.test.ts`、e2e「F9.8…」 | ✅ |
| **Sky-Drones API** – "API reference: cloud.sky-drones.com/swagger/" | OpenAPI 規格 `/api/v2/schema`、Swagger UI `/api/v2/docs/`（`/swagger/` 轉址）、API Token（F10.1–F10.3） | `auth.test.ts`、e2e「F10/F12…」 | ✅ |

## 標示 ◐ 的項目（Integrated UTM 的三列與 DroneLogbook）

* **Integrated UTM（Altitude Angel、AirMap、High Lander）**：這些是需要商業合約與 API 金鑰的外部服務，本專案沒有它們的帳號，也無法從這裡驗證它們的 API，所以沒有內建它們的專屬對接。Athena-sky 提供同樣的流程（空域資料、3D 空域體積、衝突檢查、即時飛行授權、空域保留、公開安全地圖、即時空域監控與通知），並有兩個串接點：
  * 空域資料：`AirspaceProvider`（`apps/server/src/airspace/providers.ts`），已實作 GeoJSON 空域來源；
  * 飛行授權與公開地圖：`FlightAuthority`（`apps/server/src/airspace/authority.ts`），已實作 HTTP/JSON 協定（[UTM_AUTHORITY.md](UTM_AUTHORITY.md)）：申請送出、等待決定、撤銷、取消、機關的公開地圖連結，並附參考實作 `apps/simulator/src/mock-authority.ts`（`athena-utm-authority`）。

  要接上上述其中一個服務，需要寫一個把該協定轉成它的 API 的橋接服務，或實作上述介面（各需該服務的帳號與 API 文件）。
* **DroneLogbook Integration**：DroneLogbook 的匯入 API 格式沒有公開。Athena-sky 的日誌簿連接器（`LogbookProvider`）以 JSON 紀錄或 multipart CSV 上傳飛行紀錄，可設定端點與加密儲存的 API 金鑰，支援手動與自動匯出。

## 驗證方式

* 單元與整合測試：`npm test`（Vitest，29 個檔案、359 個測試）；端對端測試：`npm run test:e2e`（Playwright，29 個情境）。
* 第 19 輪由未參與開發的 agent 獨立審查（commit c4d5a21）：建置、型別檢查、全部測試與實際操作示範伺服器，結論 PASS。
* 第 20 輪由未參與開發的 agent 依官方文件逐句審查（自行讀取上方來源）：沒有重大問題，指出 4 項次要問題（舊版 PX4 日誌的馬達判讀、Flight Locations 的 2,000 筆上限、外部 UTM 授權串接點、機隊地圖的歷史與下一任務視覺）與 7 項小問題，均已修正（第 21 輪重新審查）。
