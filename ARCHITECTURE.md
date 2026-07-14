# 書窩 Booknook — 架構說明

## 資料夾結構

```
lib/
  models/       純資料模型（immutable data class，含 copyWith）
  data/         Repository 介面 + In-Memory Mock 實作 + 種子資料
  providers/    ChangeNotifier，包裝 repository，供畫面消費
  theme/        （UI/UX designer 負責）純展示型主題定義
  widgets/common/ （UI/UX designer 負責）純展示型元件
  screens/      （之後由 frontend-developer 負責）畫面組裝
```

## 狀態管理選型：`provider`

需求明確要求「頁面盡量精簡、不要過度複雜」，且目前只有本地 mock 資料、沒有複雜的跨頁面非同步事件流。`provider` 提供最低學習成本的 `ChangeNotifier` 模式，足以應付「列表 + 篩選 + 少量表單」的資料流，不需要 Bloc / Riverpod 這類額外的樣板與抽象層。四個 `ChangeNotifier`（`UserProvider`、`LibraryProvider`、`CommunityProvider`、`MarketplaceProvider`）各自對應一組畫面（我的／書籍／社群／市集），並在建構子注入 repository 介面，達成依賴反轉：畫面只認得 provider，provider 只認得 repository 介面，測試或替換實作皆不影響上層。

## 模型關聯圖

```
User ──1───∞── ReadingRecord ──∞───1── Book
  │                                      │
  │                                      ├──∞── Review ──∞──1 User（評論作者）
  │                                      │         └─ BookRatingSummary（由 Review 聚合計算，非儲存欄位）
  │                                      │
  │                                      └──∞── CommunityPost（可選 bookId，亦可為無關書籍的綜合討論）
  │                                                  └─∞──1 User（發文者）
  │
  └──1───∞── MarketplaceListing ──∞───1── Book
                    └─∞──1 User（賣家 sellerId）
```

- `Book` 是核心樞紐：一本書可以有多筆 `Review`（讀者評價）、多筆 `MarketplaceListing`（不同賣家各自上架）、多筆 `CommunityPost`（討論串）、被多個使用者的 `ReadingRecord` 引用（各自的想讀/在讀/讀過狀態）。
- `BookRatingSummary`（療癒度均值、燒腦度均值、推薦度百分比）不是獨立儲存的欄位，而是 `ReviewRepository.getSummaryForBook()` 即時從該書所有 `Review` 聚合計算而得，避免 mock 資料出現「儲存值與明細不一致」的問題。
- `MarketplaceListing.isFavorited` 目前簡化為欄位存在單一 listing 上（demo 用單一使用者情境），未來多使用者收藏需求應改為獨立的 `Favorite(userId, listingId)` 關聯表。

## Repository 介面一覽

| Repository | 檔案 | 主要方法 |
|---|---|---|
| `UserRepository` | `lib/data/user_repository.dart` | `getAll` `getById` `getCurrentUser` `updateUser` |
| `BookRepository` | `lib/data/book_repository.dart` | `getAll` `getById` `search` `getGenres` |
| `ReviewRepository` | `lib/data/review_repository.dart` | `getByBookId` `getByUserId` `getSummaryForBook` `addReview` `markHelpful` |
| `ReadingRecordRepository` | `lib/data/reading_record_repository.dart` | `getByUserId` `getForUserAndBook` `setStatus` |
| `MarketplaceListingRepository` | `lib/data/marketplace_listing_repository.dart` | `getAll` `getByBookId` `getBySellerId` `addListing` `toggleFavorite` `markSold` |
| `CommunityPostRepository` | `lib/data/community_post_repository.dart` | `getAll` `getByBookId` `addPost` |

所有方法皆宣告為 `Future<...>`，即使目前的 `InMemory*Repository` 是同步記憶體操作，這是刻意設計：畫面/provider 端從一開始就以非同步方式呼叫，未來替換成真實後端（REST/GraphQL/Firebase）時，只需要新增例如 `ApiUserRepository implements UserRepository`，不需要更動 provider 或畫面任何一行程式碼。

## 未來接真實後端時該換哪些檔案

1. 新增 `lib/data/api/` 或直接在既有位置新增 `Http*Repository implements XxxRepository`，實作內容改為呼叫真實 API。
2. `lib/data/mock_seed_data.dart` 整份不再需要（僅供 in-memory 版本使用）。
3. Provider 層（`lib/providers/*.dart`）完全不用改：建構子只認介面型別，只需在組裝（`main.dart` 的 `MultiProvider` 設定，由其他 agent 負責）時把注入的實作換成新的 `Http*Repository`。
4. 若後端回傳格式與現有 model 欄位不同，僅需在新 repository 實作內做 DTO → model 的轉換，`lib/models/` 的欄位定義維持給前端使用的穩定契約。
5. 認證後若「目前使用者」不再是寫死的 `currentUserId`（見 `lib/data/mock_seed_data.dart`），需將這個概念改為由登入狀態提供，並讓 `LibraryProvider`／`MarketplaceProvider`／`CommunityProvider` 改為從一個新的 `AuthProvider` 取得目前使用者 id，而不是直接 import 常數。
