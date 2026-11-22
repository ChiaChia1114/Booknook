# Athena-sky 功能規格與對照表（Feature Parity Matrix）

本文件列出 Sky-Drones Cloud 的每一項公開功能，以及 Athena-sky 對應的實作位置與驗證方式。

## 資料來源與限制

| 來源 | 狀態 |
|---|---|
| https://sky-drones.com/sky-drones-cloud（行銷頁） | 受 Cloudflare 機器人驗證保護，自動化工具無法讀取，因此**未**直接引用。 |
| https://docs.sky-drones.com/flight-operations/cloud 及其 10 個子頁（官方文件） | ✅ 主要依據。行銷頁的段落標題（Dashboard、Drones and Operators、Flight Locations、Fleet Management、Flight Logs、3D Mission Planning、Integrated UTM、Real-Time Flights、API）與此文件一一對應。 |
| https://docs.sky-drones.com/general/sky-drones-platform（平台總覽、軟體部署） | ✅ 補充：雲端整合服務、遙測／酬載串流到客戶雲端、私有部署。 |
| https://docs.sky-drones.com/flight-operations/smartap-gcs/*（地面站文件） | ✅ 補充：Sky-Drones Cloud 被描述為 SmartAP GCS 的「web application」版本，因此雲端也具備的相關能力（多機、集結點、日誌繪圖匯出、ADS-B、高程）一併納入。 |
| https://cloud.sky-drones.com/api/v2/ | ✅ 公開 API 根路徑回傳 `organisations` 資源 → Athena-sky API 採相同的 `/api/v2/organisations/` 階層。 |
| 網路搜尋摘要（Unmanned Systems Technology、Cesium 部落格引用的官方文字） | 補充：資料「端對端加密」、日誌「永久保存」。 |

第三方商業服務（Altitude Angel／AirMap／High Lander UTM、DroneLogbook）需要各自的商業帳號與 API 金鑰，本專案無法取得，因此**沒有**內建這些服務的專屬串接。Athena-sky 的做法如下：

* **空域資料**：伺服器定義 `AirspaceProvider` 介面（`apps/server/src/airspace/providers.ts`），內建兩種實作：組織自行繪製或匯入的區域（`OrgZoneProvider`，可編輯），以及營運者設定的外部 GeoJSON 空域來源（`GeoJsonFeedProvider`，環境變數 `ATHENA_AIRSPACE_FEEDS`，例如主管機關公布的無人機限航區；唯讀、定期更新、下載失敗時沿用上一份資料）。空域檢查、飛行授權、任務檢查與飛行後合規都透過同一個 `AirspaceService` 合併所有來源。要串接 Altitude Angel 等商業服務，需另外實作一個 `AirspaceProvider`（本專案未提供）。
* **即時飛行授權與公開安全地圖**：由 Athena-sky 自己的授權流程與安全地圖提供，不會轉送給第三方 UTM。
* **日誌簿匯出**：`LogbookProvider` 介面（`apps/server/src/integrations/logbook-providers.ts`），內建兩種通用格式：JSON 飛行紀錄，以及 multipart CSV 日誌檔上傳。DroneLogbook 沒有公開的匯入 API 文件，所以沒有 DroneLogbook 專屬格式；可指向接受上述格式的端點，或新增一個 provider。

---

## 功能對照

圖例：✅ 已實作並有自動化測試　◐ 已實作，需外部服務或硬體才能完整驗證

### F1 帳號：註冊與登入（`cloud/sign-up-and-log-in`）
| 需求 | Athena-sky 實作 |
|---|---|
| F1.1 網頁註冊新帳號 | `POST /api/v2/auth/signup`；註冊時自動建立個人組織（owner）。頁面 `/signup` |
| F1.2 登入／登出 | `POST /api/v2/auth/login`、`/logout`；httpOnly Session Cookie + CSRF 雙重提交 |
| F1.3 忘記密碼（官方登入頁的 password reset 連結） | `/auth/password/reset` → 郵件（SMTP 或開發用 outbox）→ `/auth/password/reset/confirm` |
| F1.4 多人協作（mission manager、pilot 等角色） | 組織成員、邀請（已有帳號的人也需要本人接受邀請才會加入；回應不透露該 e-mail 是否已有帳號）、5 種角色權限矩陣 `packages/shared/src/roles.ts` |

### F2 Dashboard（`cloud/dashboard`）
| 需求 | 實作 |
|---|---|
| F2.1 一眼看到資產（無人機）、使用者、飛行的主要資訊 | `GET /organisations/:id/analytics/dashboard`：drones、members、pilots、flights、飛行時數、距離、平均航時、線上無人機／飛手、進行中飛行、警示 |
| F2.2 評估機隊績效 | 每日飛行次數與時數圖、Top drones／Top pilots、最近飛行、AI 分析警示 |
| F2.3 依時間區間篩選 | `from`／`to` 參數，UI 日期區間選擇器 |
| F2.4 依特定機隊（fleet）篩選 | `fleetId` 參數，UI 機隊下拉選單 |
| F2.5 自訂資料顯示（圖表、熱度圖、AI 趨勢與異常） | Dashboard 為可自訂的 widget 格狀版面：顯示／隱藏／排序，版面依使用者儲存（`GET/PUT /organisations/:id/preferences/dashboard`）。內含 KPI、依飛手／依無人機的飛行次數與飛行時數柱狀圖、每日飛行次數與時數、AI 警示、維修狀態、最近飛行；飛行熱度圖（`GET /analytics/heatmap`：空中遙測樣本依約 50 m 網格計數，對數色階）；AI 趨勢與異常（`GET /analytics/trends`：每趟飛行指標——耗電率、振動、馬達不平衡、健康分數、航線偏差、航時等——的線性趨勢，並以穩健 z-score（中位數／MAD，\|z\| > 3.5，至少 8 趟）標示異常飛行） |

### F3 Drones and Operators 分析（`cloud/drones-and-operators`）
| 需求 | 實作 |
|---|---|
| F3.1 哪一台無人機使用最多 | `analytics/drones-operators` → `highlights.mostUsedDrone`、無人機排行（次數、時數、距離、平均航時、健康分數） |
| F3.2 最有經驗的飛手、飛行時數最高的飛手 | `highlights.mostExperiencedPilot`（時數）、`mostActivePilot`（次數）、飛手排行（時數、次數、距離、操作過的機數、最長航時） |
| F3.3 「像 Google Analytics 一樣」的分析 | 可依時間／機隊篩選、可排序表格 |

### F4 Flight Locations（`cloud/flight-locations`）
| 需求 | 實作 |
|---|---|
| F4.1 地圖顯示機隊在哪裡飛行 | `analytics/locations`：每趟飛行起點與航跡；頁面 `/locations`（Leaflet 地圖） |
| F4.2 確認作業合規、符合法規 | 飛行結束時自動合規檢查：禁航／限航區、法定高度上限（組織設定，預設 120 m）、地理圍欄、是否有核准的空域保留、是否闖入其他業者當時已核准保留的空域（公開保留才顯示業者名稱）；地圖以顏色標示違規 |
| F4.3 依時間區間與機隊篩選 | `from`／`to`／`fleetId` |

### F5 Fleet Management（`cloud/fleet-management`）
| 需求 | 實作 |
|---|---|
| F5.1 追蹤公司所有資產 | 機隊（fleets）與無人機 CRUD，序號、型號、備註 |
| F5.2 透過 LTE 與無人機即時同步資料 | Athena Link WebSocket（`/api/v2/link`），無人機以裝置金鑰連線，即時遙測 |
| F5.3 查看機上安裝的軟體版本並遠端更新 | `hello` 回報韌體版本；韌體套件上傳（`/firmware`）→ 推送 OTA → 下載、SHA-256 驗證、安裝進度回報 → 版本自動更新 |
| F5.4 看到現在哪些無人機／飛手在線上 | `GET /organisations/:id/online` 及 Live 推播的 `users` 名單 |
| F5.5 單一畫面呈現全機隊狀態：去過哪裡、下一個任務、將遭遇的地形 | 機隊地圖（最後位置與航跡）、下一個排程任務、任務沿線地形剖面（地形最低／最高、最小離地淨空） |
| F5.6 飛行時數、電池壽命、即時飛行／飛行日誌 | 每台累計飛行時數、電池循環次數與健康度估計、連到即時畫面與日誌 |
| F5.7 維修排程（整合協作：maintenance schedules） | 頁面 `/maintenance`：每台無人機的保養工作，依飛行時數、飛行次數、天數任一先到為準；用掉 90% 以上標示「即將到期」，超過為「逾期」；可指派負責人（負責人與具「管理無人機」權限的角色——擁有者、管理員——可標記完成，完成後重新計算週期；只改備註或負責人不會重送到期通知）；維修紀錄（排程保養與臨時維修）；一鍵加入預設保養計畫。伺服器啟動後、每小時與每趟飛行結束時檢查，狀態改變時發出一次通知（通知中心＋即時推播） |
| F5.8 預測性維修（predictive maintenance） | 以每趟飛行分析指標（振動、馬達輸出不平衡、每顆電芯電壓驟降、耗電率、健康分數）對累計飛行時數做線性趨勢，預測距離維修門檻還有幾小時：已超過或 10 小時內為「需處理」、50 小時內為「注意」。為避免誤報，趨勢必須顯著（斜率 t 值 ≥ 2.5），且只往後外推資料涵蓋時數的 2 倍（一小時的資料不會被拿來預測幾十小時後）；需處理時通知一次，並附處理建議。正常的指標也說明趨勢：朝門檻移動（約剩幾小時）、朝門檻但太遠無法預測、尚無明確趨勢（附 R²），或遠離門檻。無人機頁與 Dashboard 也顯示維修狀態 |

### F6 Flight Logs（`cloud/flight-logs`）
| 需求 | 實作 |
|---|---|
| F6.1 每份飛行日誌都存在雲端、隨處可取用，且永久保存 | 線上飛行自動記錄（遙測樣本、事件）；離線上傳 PX4 ULog（`.ulg`）／CSV；不會自動刪除。只有實際執行任務的飛行才記為該任務的飛行（任務開始或無人機回報 MISSION 模式；飛行中途開始任務也會補記），飛手記為持有控制權的人，否則為送出起飛／任務開始指令的人；任務飛完並降落後即從無人機的「已載入任務」清除（最後一項是返航或降落的任務，飛到該項後降落即算完成；中途返航則保留）；無人機拒絕「開始任務」時不算任務飛行 |
| F6.2 詳細日誌分析，及早發現機械問題（官方稱 post-flight AI analytics） | 飛行後分析引擎：振動、馬達輸出不平衡、電壓驟降、電流異常、GPS 品質、姿態震盪、重落地、低電量、通訊中斷，再加上與該機歷史基線比較的統計異常偵測（z-score），產出健康分數與發現 |
| F6.3 歷史、進行中、未來作業的完整紀錄 | 飛行列表（完成／進行中）＋任務排程（未來）。上傳或飛行只對應到計畫時間在前後 12 小時內的排程（同一台無人機、同一個任務），提早幾天飛同一個任務不會吃掉之後的排程；已上傳的排程若被別的任務取代，會回到「已排程」 |
| F6.4 持續監控全機隊與個別機／飛手 | 儀表板警示、無人機健康趨勢、Webhook `alert.raised` |
| F6.5 DroneLogbook 整合（匯出日誌給合作夥伴） | ◐ 日誌簿匯出連接器（`LogbookProvider`：JSON 紀錄或 multipart CSV 上傳；端點 URL＋加密儲存的 API 金鑰；手動或自動匯出）。無 DroneLogbook 專屬格式（其 API 未公開）；另提供 CSV／KML／GPX／JSON 匯出 |
| F6.6 日誌繪圖與匯出（GCS「Logs Analysis」：選欄位繪圖、匯出圖片／KML／CSV） | ULog 主題／欄位瀏覽與任意欄位繪圖、PNG 圖片匯出、KML／CSV／GPX 匯出 |
| F6.7 航線偏差分析（route deviation） | 任務飛行比對「起飛時上傳給無人機的那份計畫」（快照，之後修改任務不影響）與實際航跡：橫向偏差的平均、95 百分位與最大值、超出 10 m 走廊的時間比例、規劃航線完成比例（沿航線單向比對，來回重疊的航線也能正確對應到返程）、航段中的最大高度偏差（不計起飛爬升與最後下降；原地爬升或下降的垂直航段以其高度範圍比對，前後航段各自用到達與離開時的高度）；自動返航不列入比對——任務最後的返航（RTL）航段，以及無人機處於返航或降落模式的所有時段（含故障保護返航，之後未飛的航段算未完成）；偏離時間超過 15% 或完成度低於 80% 時列為發現。飛行頁地圖疊上規劃航線（虛線）與最大偏差點 |
| F6.8 自訂合規與績效報表匯出 | 頁面 `/reports`、`GET /reports/flights`：可依期間、機隊、無人機、飛手篩選，並選擇段落——摘要、績效（依無人機／飛手：時數、距離、平均健康分數、耗電率、航線偏差、發現數）、合規（無問題飛行比例、法規問題類型、飛行中的 UTM 警示、在保養逾期時起飛的飛行）、維修、AI 偵測、飛行清單。輸出 JSON、CSV（文字欄位防試算表公式注入）或可列印 HTML（全部跳脫、CSP `default-src 'none'`，可直接列印成 PDF） |

### F7 3D Mission Planning（`cloud/3d-mission-planning`）
| 需求 | 實作 |
|---|---|
| F7.1 互動式新增航點 | CesiumJS 3D 地球，點擊地面新增航點 |
| F7.2 從任何視角檢視：旋轉、改變視角、傾斜、地表視角、回到正交視角 | 相機工具列：左右旋轉、傾斜、地表視角、俯視正交（orthographic），加上滑鼠自由操作 |
| F7.3 互動調整航點位置與高度 | 拖曳航點改水平位置；Shift＋拖曳改高度；側欄數值編輯 |
| F7.4 完整任務（GCS 的 autonomous flights、rally points） | 起飛／航點／盤旋／降落／返航／變速／拍照、集結點（多個緊急降落點）、地理圍欄、測繪掃描（survey）產生器、任務統計（距離、時間、電量）、QGC `.plan` 與 `QGC WPL 110` 匯入匯出、上傳到線上無人機。返航（RTL）在規劃中與無人機的行為一致：飛往起降點或最近的集結點（PX4、ArduPilot 與模擬器的預設），航線圖、統計、飛行模擬、航線最佳化與地形跟隨都依此計算。上傳（單機與群飛）前會先做空域檢查：航線走廊穿過禁航／限航／臨時限制區或其他業者保留的空域時拒絕上傳並列出衝突；只有能審核授權的角色（經理以上，且需有操控權限）可明確勾選覆寫，覆寫寫入稽核紀錄。組織自己的已核准授權視為許可而不是衝突（若是核發給同組織另一台無人機，標為需審核） |

### F8 Integrated UTM（`cloud/integrated-utm`）
| 需求 | 實作 |
|---|---|
| F8.1 整合 UTM 服務（Altitude Angel、AirMap、High Lander） | ◐ `AirspaceProvider` 介面：組織區域＋外部 GeoJSON 空域來源（`ATHENA_AIRSPACE_FEEDS`），`GET /api/v2/airspace/providers` 顯示各來源狀態。未內建商業 UTM 的專屬串接 |
| F8.2 3D 地形與地面危害（例如電線） | 3D 規劃器顯示地形（Terrarium DEM）、空域體積（上下限擠出）、電線／障礙物危害緩衝區 |
| F8.3 天氣資訊 | `GET /api/v2/weather`（Open-Meteo），含風速、陣風、降水、能見度與可飛判定（go／caution／no-go） |
| F8.4 空域資料（區域詳細資訊） | 空域區（禁航、限航、管制、危險、臨時）CRUD；`POST /airspace/check` 回傳衝突與建議；`POST /missions/:id/airspace-check`（可帶 `droneId`）檢查整條任務走廊 |
| F8.5 即時飛行申請與授權，保留空域 | 授權申請 → 自動衝突檢查（空域區、既有保留、時間、高度）→ 自動核准、駁回或待人工審核；經理可人工決議。其他業者的保留為阻擋；組織自己的保留是許可（同一台或未指定機體），保留給同組織另一台無人機時改為待審核——授權申請、`/airspace/check`、任務檢查與核准時的重新檢查都用同一套規則；非公開的保留不揭露業者名稱、編號或識別碼。取消授權會立即更新即時監控 |
| F8.6 保留空域公開顯示在安全地圖上 | 公開頁 `/safety-map` 與 `GET /api/v2/public/safety-map`（免登入） |
| F8.7 Cylinder（圓柱）與 Corridor（走廊）飛行計畫 | 兩種幾何皆支援，可由任務航線自動產生走廊 |
| F8.8 即時空域監控與通知 | UTM 監控器（`apps/server/src/airspace/utm-monitor.ts`）：空中無人機每 2 秒比對所有空域來源——禁航／限航／臨時限制：接近 150 m 警告、進入為嚴重；管制／危險區：無核准授權覆蓋時警告（只認同一台無人機的授權或未指定機體的組織授權，與飛行後合規檢查相同；未指定機體的組織授權只約束在其範圍內起飛的飛行，遠處的組織授權不會讓其他飛行被判為「超出授權範圍」）；電線／障礙物 50 m 內警告；組織高度上限；自家機隊間隔（水平 20 m／垂直 10 m，同一群飛作業 5 m／3 m）；有人機交通（ADS-B）與無人機故障；進入其他業者已核准保留的空域為嚴重（公開保留才顯示業者與編號）。產生的通知持久化、即時推播到主控台與頂部通知中心（未讀數、全部已讀），並送出 Webhook `utm.alert`；狀況結束（離開空域等）自動標示「結束」 |

### F9 Real-Time Flights（`cloud/real-time-flights`）
| 需求 | 實作 |
|---|---|
| F9.1 透過 LTE 即時控制與影像串流，全網頁、免安裝 | Athena Live WebSocket（`/api/v2/live`）＋瀏覽器頁面 `/live` |
| F9.2 選擇線上載具並飛行 | 線上無人機清單；指令：解鎖／上鎖、起飛、降落、返航、懸停、飛往點擊位置、模式、速度、任務開始／暫停／續飛、拍照 |
| F9.3 超低延遲 | 端到端 ping（瀏覽器→雲→無人機）RTT 顯示；影像背壓丟幀，確保延遲不累積 |
| F9.4 HD 影像搭配主要遙測 | 二進位 JPEG 影格中繼（SD 640×360／HD 1280×720）；HUD：姿態儀、高度、速度、航向、電池、GPS、連線品質、模式 |
| F9.5 單一頁面操作多台無人機 | 多機格狀檢視，每台各自影像、遙測與控制；只能觀看的角色（觀察員、任務經理）沒有指令欄，影像使用整個寬度 |
| F9.6 手動控制（SmartLink 以 USB 搖桿／遊戲手把手動控制） | 鍵盤與 Gamepad API 手動控制，含控制權鎖定（一機一控制者，其他人觀看） |
| F9.7 群組指令 | 主控台「Swarm」面板：勾選多台無人機，同時送出起飛（可設高度階梯）、懸停、返航、降落 |
| F9.9 AI 物件偵測（人、車輛）、辨識、追蹤與跟隨 | 開關 AI 需要飛手權限（關閉會結束跟隨）。雲端在即時影像上執行內建偵測器（CenterNet 架構的小型卷積網路，`apps/server/src/vision/athena-detector.json`，109 KB），在 worker thread 中每台每秒 3 幀，不阻塞即時通道；多目標追蹤（地面位置關聯，不受鏡頭移動影響）、類別投票與顏色辨識（人看上衣、車看車身）；由相機模型（位置、高度、航向、雲台俯角、視角）把物體觸地點投影到地面得到經緯度與速度；主控台影像疊框、點選物體即可「Follow」：無人機保持設定高度與距離、鏡頭朝向目標，目標被遮住會重新鎖定，消失 8 秒後懸停。已確認的物體寫入事件與飛行紀錄。具機上 AI 的無人機可改傳 `detections` 訊息（同一套追蹤、定位與跟隨） |
| F9.8 群飛（drone swarm）：同步起飛、航點、降落，並顯示各機遙測 | 編隊飛行（橫隊、縱隊、梯隊、V 字、方陣；轉角斜接，各機航段與領隊平行）或分割航線（依航線長度切割、切點內插，速度與相機觸發狀態延續到下一段）；依距離最佳指派槽位；預覽各機航線、時程與規劃最近間距（不足 10 m 需確認）。執行時同一時刻送出任務開始（同步起飛），每個同步點以「屏障」同步——先到者懸停、最後一台到達後一起出發，航段速度預先配速；最後一點自行盤旋等待，全部到齊後一起返航：返航航段由規劃器明確產生——先在原地爬升到各自的返航高度（高於所有任務高度、彼此相差 10 m），再飛回起飛點降落，交錯的回程因此有垂直間隔，預覽的間距檢查也與實際飛行一致。返航高度不超過組織的法定高度上限（空間不足時縮小間隔），任何一台超過上限時預覽會警告。飛手接手、斷線或故障保護模式時該機自動退出，其他機不再等待；作業進行中不能用一般上傳替換成員的任務；暫停／續飛／全部返航／全部降落／結束。每台的影像、遙測與群飛狀態（槽位、同步點進度、等待中）同時顯示 |

### F10 API（`cloud/api`）
| 需求 | 實作 |
|---|---|
| F10.1 公開 REST API 與 Swagger 參考 | OpenAPI 3 規格 `/api/v2/schema/`、Swagger UI `/api/v2/docs/`（`/swagger/` 轉址） |
| F10.2 API 根路徑列出 organisations | `GET /api/v2/` |
| F10.3 程式化存取（給客戶系統整合） | 個人 API Token（`Authorization: Bearer`），可限定組織 |

### F11 Everything／Integrated／Everywhere（`cloud`）
| 需求 | 實作 |
|---|---|
| F11.1 所有資料集中在一處 | 單一組織空間：機隊、飛行、日誌、任務、空域、韌體、稽核紀錄 |
| F11.2 與硬體緊密整合：無人機傳給地面站的資料也在雲端 | Athena Link 協定（參考實作：`apps/simulator`） |
| F11.3 飛行後或飛行中（LTE）同步 | 即時遙測記錄＋事後日誌上傳 |
| F11.4 整合酬載資料蒐集 | `payload` 訊息（感測資料）與酬載影像上傳，依飛行航跡自動地理標記（GCS「Geotag Images」） |
| F11.5 隨時隨地存取：指揮中心的任務經理遠端觀看並提供建議 | observer／manager 角色可即時觀看，不能操控 |

### F12 平台整合（`general/sky-drones-platform`）
| 需求 | 實作 |
|---|---|
| F12.1 飛行中遙測與酬載資料直接串流到客戶雲端 | Webhook（`telemetry`、`payload.data`、`flight.*`、`alert.raised`、`utm.alert`、`swarm.updated` 等，HMAC-SHA256 簽章、重試）＋ Live WebSocket API（API Token） |
| F12.2 整合服務：連接無人機、應用程式、夥伴與客戶軟體 | REST API＋Webhook＋日誌簿連接器 |
| F12.3 私有部署到自有伺服器 | `Dockerfile`、`docker-compose.yml`，單一 SQLite 檔案＋資料目錄（資料目錄 0700、資料庫檔案 0600，只有伺服器的使用者能讀） |
| F12.4 端對端加密 | 部署在 TLS（HTTPS／WSS）後；裝置金鑰、API Token、密碼皆雜湊儲存 |
| F12.5 多機與無人機間協作（GCS「Multiple Drones」） | 多機即時頁面、ADS-B 交通資訊（機上 pingRX 回報） |

---

## 使用者介面

* 設計系統（`apps/web/src/styles.css`）：深色與淺色主題（右上角切換），色彩、間距、圓角、陰影皆為 CSS 變數；側欄與頂列固定為深色；字型 Inter（自行託管，不連外部 CDN）；圖示一律使用 lucide-react（向量圖示，取代文字符號）。
* 外框：可收合的側欄（概覽／作業／資產與資料／組織），頂列有組織切換、角色、連線狀態、即時畫面捷徑、通知中心、主題切換與帳號選單（個人資料、設定、登出）。
* 登入頁：左側產品介紹、右側表單；窄螢幕只顯示表單。
* 以地圖為主的即時主控台與任務規劃器：地圖全版，深色半透明面板（工具列、影像堆疊、事件紀錄、重新定位、群飛、規劃側欄）浮在地圖上；淺色主題下這些面板仍維持深色，以保持在地圖上的可讀性。
* 地圖：深色主題下 OpenStreetMap 圖磚以濾鏡轉為深色（衛星影像不變），圖磚載入前的底色與主題一致。
* 頂列在任何寬度都不會超出畫面：組織選單與狀態膠囊會縮短，1100 px 以下角色標籤移到帳號選單、使用者名稱縮短，900 px 以下只顯示狀態燈號與頭像。
* 窄螢幕：900 px 以下側欄改為從頂列「選單」按鈕開啟的抽屜，雙欄頁面改為單欄；640 px 以下頂列精簡為圖示，通知中心改為全寬，頁面不會出現水平捲動；即時主控台依主控台本身的寬度（不受側欄展開影響）決定工具列樣式：放不下一列文字標籤（含軟體 3D 警示與群飛狀態）時改為只顯示圖示的單列，很窄的手機上圖示可換到第二列而不會超出畫面，下拉選單顯示在影像欄之上；手機上的側面板停在事件紀錄上方；面板與地圖控制項一律放在工具列下方；窄主控台的影像欄自動縮窄。寬表格在自己的框內左右捲動，手機上影像改為下方橫向捲動列，事件紀錄預設收合；重新定位、群飛與詳情面板一次只開一個。
* 3D 主控台與規劃器會自動避開重疊的標籤（無人機標籤依實際螢幕矩形往上錯開，互不重疊；被無人機標籤蓋住的航點編號暫時隱藏；規劃器航點標籤重疊時保留選取中的航點與較前面的航點）。
* 3D 規劃器的「Fit mission」、俯視正交與開啟既有任務時的視角，都會把任務放在實際看得到的範圍內（避開上方工具列、桌面版右側面板或手機的下方面板）。規劃器標籤依螢幕矩形擺放：優先在標記上方，否則下方、右側、左側，都會重疊才隱藏（選取中的航點一定顯示）。

## AI 偵測模型的來源與驗證

* 訓練資料：模擬器相機以與即時影像完全相同的流程產生（畫面含 HUD、JPEG 壓縮、相同的縮圖函式），5 個不同世界、4000 張訓練／600 張測試（`tools/vision/make-dataset.ts`）。過小或大部分在畫面外的物體標為「忽略」。
* 訓練：`tools/vision/train_detector.py`，只用 numpy（im2col 卷積、手寫反向傳播、Adam），反向傳播以數值梯度檢查驗證（最大相對誤差 2×10⁻⁷）。
* 保留測試集（600 張，IoU ≥ 0.5）：人 精確率 0.981／召回率 0.953；車輛 0.948／0.910（數值存於模型檔 `meta`，`GET /api/v2/vision/model` 可查）。
* TypeScript 推論與 numpy 的輸出一致性測試（`apps/server/test/vision.test.ts`，誤差 < 2×10⁻³）。
* 未參與訓練的新世界（120 張，10–25 m 高）：人 精確率 1.00／召回率 0.98、地面定位誤差中位數 0.2 m、顏色辨識 93%；車輛 1.00／0.98、1.0 m、90%。
* 限制：內建模型是在模擬器影像上訓練的，用於真實無人機影像時需換成以真實空拍資料訓練的模型（相同檔案格式 `athena-centernet-1`，或由機上 AI 傳送 `detections`）。重新訓練：`npx tsx tools/vision/make-dataset.ts <資料夾>`，再執行 `python tools/vision/train_detector.py <資料夾> apps/server/src/vision/athena-detector.json apps/server/test/fixtures/detector-parity.json`。

## 驗證方式

* 單元與整合測試：`npm test`（Vitest，20 個檔案、232 個測試）
* 端對端測試：`npm run test:e2e`（Playwright＋內建虛擬機隊，17 個情境（含手機與平板、不同角色），同時檢查瀏覽器沒有非預期的錯誤）
* 型別檢查：`npm run typecheck`
* ULog 格式交叉驗證（可重現，需要 Python）：`pip install pyulog && npm run verify:ulog`（`tools/ulog-crosscheck/`）。流程：模擬器寫出 `.ulg` → PX4 官方參考實作 pyulog 讀取，並用 pyulog 自己的 writer 重寫 → 本專案的解析器讀取這兩個檔案，每個主題的樣本、欄位值、記錄訊息、參數與 info 都必須與 pyulog 完全相同，正規化後的飛行資料也必須一致。因為需要 Python，這一步沒有放進 `npm test`。

| 功能 | 自動化測試 |
|---|---|
| F1 | `apps/server/test/auth.test.ts`（F1、F1.4）、e2e「F1 sign up…」 |
| F2 | `apps/server/test/analytics-integrations.test.ts`（F2）、`maintenance.test.ts`（熱度圖、趨勢與異常、偏好設定）、e2e「F2/F3/F4…」、e2e「F14…」（自訂 Dashboard）、e2e「Responsive…」（手機與平板） |
| F3 | `analytics-integrations.test.ts`（F3）、e2e「F2/F3/F4…」 |
| F4 | `analytics-integrations.test.ts`（F4）、`flights.test.ts`（F4.2 compliance）、e2e「F2/F3/F4…」 |
| F5 | `realtime.test.ts`（在線狀態、韌體 OTA、機隊列表）、`missions-airspace.test.ts`（下一個任務＋地形）、`maintenance.test.ts`（到期計算、權限、通知、預設計畫、預測性維修）、`packages/shared/test/maintenance.test.ts`、e2e「F5…」、e2e「F14…」（標記保養完成） |
| F6 | `flights.test.ts`（含自動返航與集結點的航線比對）、`ulog.test.ts`、`regressions.test.ts`（惡意 ULog、長 CSV、時間單位、異常偵測下限）、`realtime.test.ts`（即時記錄、機上日誌同步）、`analytics-integrations.test.ts`（日誌簿匯出兩種格式）、e2e「F6…」、`npm run verify:ulog`、`maintenance.test.ts`（報表段落與篩選、保養逾期飛行、CSV 公式防護、HTML 跳脫、航線偏差）、`packages/shared/test/planning.test.ts`（偏差演算法）、e2e「F14…」（報表預覽與 CSV 匯出） |
| F7 | `packages/shared/test/mission.test.ts`、`missions-airspace.test.ts`（F7、地形快取權限）、`realtime.test.ts`（任務上傳與自主執行）、`mission-upload.test.ts`（上傳前空域檢查與覆寫、自家授權、返航結束的任務卸載、拒絕開始的任務）、e2e「F7…」（含規劃器空域圖層）、e2e「F7b…」（桌面與手機的取景、標籤不重疊） |
| F8 | `missions-airspace.test.ts`（F8）、`utm.test.ts`（闖入其他業者保留空域、自家保留的處理）、`flights.test.ts`（保留空域合規）、`mission-upload.test.ts`（任務走廊對其他業者保留空域）、`swarm.test.ts`（群飛上傳前空域檢查）、`regressions.test.ts`（外部空域來源、授權排序）、`packages/shared/test/geo.test.ts`、e2e「F8…」、e2e「F8b…」（受限區任務上傳與覆寫）、e2e「Security…」 |
| F9 | `realtime.test.ts`（指令、控制權、影像、延遲、手動控制）、e2e「F9…」、e2e「F9c…」（觀察員與任務經理的影像大小） |
| F10 | `auth.test.ts`（F10 API tokens、OpenAPI）、e2e「F10/F12…」 |
| F11 | `realtime.test.ts`（觀察員觀看、酬載資料）、`flights.test.ts`（影像地理標記） |
| F12 | `analytics-integrations.test.ts`（Webhook 簽章、重試、SSRF 阻擋）、`realtime.test.ts`（即時事件 Webhook）、Docker 部署設定（runtime 安裝已驗證） |
