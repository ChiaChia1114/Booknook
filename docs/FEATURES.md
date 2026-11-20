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

第三方商業服務（Altitude Angel／AirMap／High Lander UTM、DroneLogbook）需要各自的商業帳號與 API 金鑰，本專案無法取得。Athena-sky 以**提供者介面（provider adapter）＋內建實作**提供相同的工作流程（空域資料、地面危害、天氣、即時飛行授權、公開安全地圖、日誌匯出），接上真實服務只需實作對應的 adapter。

---

## 功能對照

圖例：✅ 已實作並有自動化測試　◐ 已實作，需外部服務或硬體才能完整驗證

### F1 帳號：註冊與登入（`cloud/sign-up-and-log-in`）
| 需求 | Athena-sky 實作 |
|---|---|
| F1.1 網頁註冊新帳號 | `POST /api/v2/auth/signup`；註冊時自動建立個人組織（owner）。頁面 `/signup` |
| F1.2 登入／登出 | `POST /api/v2/auth/login`、`/logout`；httpOnly Session Cookie + CSRF 雙重提交 |
| F1.3 忘記密碼（官方登入頁的 password reset 連結） | `/auth/password/reset` → 郵件（SMTP 或開發用 outbox）→ `/auth/password/reset/confirm` |
| F1.4 多人協作（mission manager、pilot 等角色） | 組織成員、邀請、5 種角色權限矩陣 `packages/shared/src/roles.ts` |

### F2 Dashboard（`cloud/dashboard`）
| 需求 | 實作 |
|---|---|
| F2.1 一眼看到資產（無人機）、使用者、飛行的主要資訊 | `GET /organisations/:id/analytics/dashboard`：drones、members、pilots、flights、飛行時數、距離、平均航時、線上無人機／飛手、進行中飛行、警示 |
| F2.2 評估機隊績效 | 每日飛行次數與時數圖、Top drones／Top pilots、最近飛行、AI 分析警示 |
| F2.3 依時間區間篩選 | `from`／`to` 參數，UI 日期區間選擇器 |
| F2.4 依特定機隊（fleet）篩選 | `fleetId` 參數，UI 機隊下拉選單 |

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
| F4.2 確認作業合規、符合法規 | 飛行結束時自動合規檢查：禁航／限航區、法定高度上限（組織設定，預設 120 m）、地理圍欄、是否有核准的空域保留；地圖以顏色標示違規 |
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

### F6 Flight Logs（`cloud/flight-logs`）
| 需求 | 實作 |
|---|---|
| F6.1 每份飛行日誌都存在雲端、隨處可取用，且永久保存 | 線上飛行自動記錄（遙測樣本、事件）；離線上傳 PX4 ULog（`.ulg`）／CSV；不會自動刪除 |
| F6.2 詳細日誌分析，及早發現機械問題（官方稱 post-flight AI analytics） | 飛行後分析引擎：振動、馬達輸出不平衡、電壓驟降、電流異常、GPS 品質、姿態震盪、重落地、低電量、通訊中斷，再加上與該機歷史基線比較的統計異常偵測（z-score），產出健康分數與發現 |
| F6.3 歷史、進行中、未來作業的完整紀錄 | 飛行列表（完成／進行中）＋任務排程（未來） |
| F6.4 持續監控全機隊與個別機／飛手 | 儀表板警示、無人機健康趨勢、Webhook `alert.raised` |
| F6.5 DroneLogbook 整合（匯出日誌給合作夥伴） | ◐ 日誌簿匯出連接器（端點 URL＋API 金鑰、手動或自動匯出）；另提供 CSV／KML／GPX／JSON 匯出 |
| F6.6 日誌繪圖與匯出（GCS「Logs Analysis」：選欄位繪圖、匯出圖片／KML／CSV） | ULog 主題／欄位瀏覽與任意欄位繪圖、PNG 圖片匯出、KML／CSV／GPX 匯出 |

### F7 3D Mission Planning（`cloud/3d-mission-planning`）
| 需求 | 實作 |
|---|---|
| F7.1 互動式新增航點 | CesiumJS 3D 地球，點擊地面新增航點 |
| F7.2 從任何視角檢視：旋轉、改變視角、傾斜、地表視角、回到正交視角 | 相機工具列：左右旋轉、傾斜、地表視角、俯視正交（orthographic），加上滑鼠自由操作 |
| F7.3 互動調整航點位置與高度 | 拖曳航點改水平位置；Shift＋拖曳改高度；側欄數值編輯 |
| F7.4 完整任務（GCS 的 autonomous flights、rally points） | 起飛／航點／盤旋／降落／返航／變速／拍照、集結點（多個緊急降落點）、地理圍欄、測繪掃描（survey）產生器、任務統計（距離、時間、電量）、QGC `.plan` 與 `QGC WPL 110` 匯入匯出、上傳到線上無人機 |

### F8 Integrated UTM（`cloud/integrated-utm`）
| 需求 | 實作 |
|---|---|
| F8.1 整合 UTM 服務（Altitude Angel、AirMap、High Lander） | ◐ UTM 提供者介面＋內建 Athena UTM 提供者（組織可管理空域資料） |
| F8.2 3D 地形與地面危害（例如電線） | 3D 規劃器顯示地形（Terrarium DEM）、空域體積（上下限擠出）、電線／障礙物危害緩衝區 |
| F8.3 天氣資訊 | `GET /api/v2/weather`（Open-Meteo），含風速、陣風、降水、能見度與可飛判定（go／caution／no-go） |
| F8.4 空域資料（區域詳細資訊） | 空域區（禁航、限航、管制、危險、臨時）CRUD；`POST /airspace/check` 回傳衝突與建議 |
| F8.5 即時飛行申請與授權，保留空域 | 授權申請 → 自動衝突檢查（空域區、既有保留、時間、高度）→ 自動核准、駁回或待人工審核；經理可人工決議 |
| F8.6 保留空域公開顯示在安全地圖上 | 公開頁 `/safety-map` 與 `GET /api/v2/public/safety-map`（免登入） |
| F8.7 Cylinder（圓柱）與 Corridor（走廊）飛行計畫 | 兩種幾何皆支援，可由任務航線自動產生走廊 |

### F9 Real-Time Flights（`cloud/real-time-flights`）
| 需求 | 實作 |
|---|---|
| F9.1 透過 LTE 即時控制與影像串流，全網頁、免安裝 | Athena Live WebSocket（`/api/v2/live`）＋瀏覽器頁面 `/live` |
| F9.2 選擇線上載具並飛行 | 線上無人機清單；指令：解鎖／上鎖、起飛、降落、返航、懸停、飛往點擊位置、模式、速度、任務開始／暫停／續飛、拍照 |
| F9.3 超低延遲 | 端到端 ping（瀏覽器→雲→無人機）RTT 顯示；影像背壓丟幀，確保延遲不累積 |
| F9.4 HD 影像搭配主要遙測 | 二進位 JPEG 影格中繼（SD 640×360／HD 1280×720）；HUD：姿態儀、高度、速度、航向、電池、GPS、連線品質、模式 |
| F9.5 單一頁面操作多台無人機 | 多機格狀檢視，每台各自影像、遙測與控制 |
| F9.6 手動控制（SmartLink 以 USB 搖桿／遊戲手把手動控制） | 鍵盤與 Gamepad API 手動控制，含控制權鎖定（一機一控制者，其他人觀看） |

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
| F12.1 飛行中遙測與酬載資料直接串流到客戶雲端 | Webhook（`telemetry`、`payload.data`、`flight.*`、`alert.raised` 等，HMAC-SHA256 簽章、重試）＋ Live WebSocket API（API Token） |
| F12.2 整合服務：連接無人機、應用程式、夥伴與客戶軟體 | REST API＋Webhook＋日誌簿連接器 |
| F12.3 私有部署到自有伺服器 | `Dockerfile`、`docker-compose.yml`，單一 SQLite 檔案＋資料目錄 |
| F12.4 端對端加密 | 部署在 TLS（HTTPS／WSS）後；裝置金鑰、API Token、密碼皆雜湊儲存 |
| F12.5 多機與無人機間協作（GCS「Multiple Drones」） | 多機即時頁面、ADS-B 交通資訊（機上 pingRX 回報） |

---

## 驗證方式
* 單元／整合測試：`npm test`（Vitest，涵蓋上述每一項功能）
* 端對端測試：`npm run test:e2e`（Playwright＋內建虛擬機隊）
* 型別檢查：`npm run typecheck`
