import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../data/mock_seed_data.dart' show currentUserId;
import '../../models/community_post.dart';
import '../../models/reading_record.dart';
import '../../models/user.dart';
import '../../providers/community_provider.dart';
import '../../providers/library_provider.dart';
import '../../providers/marketplace_provider.dart';
import '../../providers/user_provider.dart';
import '../../theme/colors.dart';
import '../../theme/spacing.dart';
import '../../widgets/common/book_cover_block.dart';
import '../../widgets/common/mascot_badge.dart';
import '../book_detail/book_detail_screen.dart';
import '../marketplace/listing_detail_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  Future<List<ReadingRecord>>? _friendRecordsFuture;

  Future<List<ReadingRecord>> _loadFriendRecords(LibraryProvider library, List<User> users) async {
    final all = <ReadingRecord>[];
    for (final user in users) {
      if (user.id == currentUserId) continue;
      final records = await library.recordsForUser(user.id);
      all.addAll(records.where((r) => r.status != ReadingStatus.wantToRead));
    }
    all.sort((a, b) {
      final aDate = a.finishedAt ?? a.startedAt ?? DateTime(2000);
      final bDate = b.finishedAt ?? b.startedAt ?? DateTime(2000);
      return bDate.compareTo(aDate);
    });
    return all.take(10).toList();
  }

  @override
  Widget build(BuildContext context) {
    final userProvider = context.watch<UserProvider>();
    final library = context.watch<LibraryProvider>();
    final marketplace = context.watch<MarketplaceProvider>();
    final community = context.watch<CommunityProvider>();

    final isLoading =
        userProvider.isLoading || library.isLoading || marketplace.isLoading || community.isLoading;

    return Scaffold(
      appBar: AppBar(
        title: const Text('書窩 Booknook'),
        actions: const [
          Padding(
            padding: EdgeInsets.only(right: AppSpacing.md),
            child: MascotBadge(size: 32),
          ),
        ],
      ),
      body: isLoading
          ? const Center(child: CircularProgressIndicator())
          : _buildBody(context, userProvider, library, marketplace, community),
    );
  }

  Widget _buildBody(
    BuildContext context,
    UserProvider userProvider,
    LibraryProvider library,
    MarketplaceProvider marketplace,
    CommunityProvider community,
  ) {
    _friendRecordsFuture ??= _loadFriendRecords(library, userProvider.allUsers);

    final featuredBooks = library.books.take(6).toList();
    final listings = marketplace.availableListings.take(6).toList();
    final featuredPost = community.posts.isEmpty
        ? null
        : (List<CommunityPost>.of(community.posts)..sort((a, b) => b.replyCount.compareTo(a.replyCount)))
            .first;

    return ListView(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
      children: [
        const _SectionHeader(title: '本週精選書封'),
        SizedBox(
          height: 190,
          child: featuredBooks.isEmpty
              ? _EmptyHint(text: '目前還沒有書籍資料')
              : ListView.separated(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                  itemCount: featuredBooks.length,
                  separatorBuilder: (_, _) => const SizedBox(width: AppSpacing.sm),
                  itemBuilder: (context, index) {
                    final book = featuredBooks[index];
                    return GestureDetector(
                      onTap: () => Navigator.push(
                        context,
                        MaterialPageRoute(builder: (_) => BookDetailScreen(bookId: book.id)),
                      ),
                      child: BookCoverBlock(
                        title: book.title,
                        author: book.author,
                        colorIndex: book.coverColorIndex,
                      ),
                    );
                  },
                ),
        ),
        const SizedBox(height: AppSpacing.lg),
        const _SectionHeader(title: '朋友閱讀動態'),
        SizedBox(
          height: 152,
          child: FutureBuilder<List<ReadingRecord>>(
            future: _friendRecordsFuture,
            builder: (context, snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const Center(child: CircularProgressIndicator());
              }
              final records = snapshot.data ?? const <ReadingRecord>[];
              if (records.isEmpty) {
                return _EmptyHint(text: '目前還沒有朋友的閱讀動態');
              }
              return ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                itemCount: records.length,
                separatorBuilder: (_, _) => const SizedBox(width: AppSpacing.sm),
                itemBuilder: (context, index) {
                  final record = records[index];
                  final book = library.getBookById(record.bookId);
                  final user = userProvider.getById(record.userId);
                  if (book == null) return const SizedBox.shrink();
                  return GestureDetector(
                    onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute(builder: (_) => BookDetailScreen(bookId: book.id)),
                    ),
                    child: Container(
                      width: 112,
                      padding: const EdgeInsets.all(AppSpacing.sm),
                      decoration: BoxDecoration(
                        color: AppColors.surface,
                        borderRadius: BorderRadius.circular(AppRadius.cardRadius),
                        border: Border.all(color: AppColors.border),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          BookCoverBlock(
                            title: book.title,
                            colorIndex: book.coverColorIndex,
                            width: 88,
                            height: 68,
                          ),
                          const SizedBox(height: AppSpacing.xs),
                          Text(
                            user?.name ?? '書友',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.labelMedium,
                          ),
                          Text(
                            record.status == ReadingStatus.finished ? '剛讀完' : '正在讀',
                            style: Theme.of(context).textTheme.labelSmall,
                          ),
                        ],
                      ),
                    ),
                  );
                },
              );
            },
          ),
        ),
        const SizedBox(height: AppSpacing.lg),
        const _SectionHeader(title: '二手好書'),
        SizedBox(
          height: 190,
          child: listings.isEmpty
              ? _EmptyHint(text: '目前市集沒有在售的書')
              : ListView.separated(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                  itemCount: listings.length,
                  separatorBuilder: (_, _) => const SizedBox(width: AppSpacing.sm),
                  itemBuilder: (context, index) {
                    final listing = listings[index];
                    final book = library.getBookById(listing.bookId);
                    if (book == null) return const SizedBox.shrink();
                    return GestureDetector(
                      onTap: () => Navigator.push(
                        context,
                        MaterialPageRoute(builder: (_) => ListingDetailScreen(listingId: listing.id)),
                      ),
                      child: Container(
                        width: 140,
                        padding: const EdgeInsets.all(AppSpacing.sm),
                        decoration: BoxDecoration(
                          color: AppColors.surface,
                          borderRadius: BorderRadius.circular(AppRadius.cardRadius),
                          border: Border.all(color: AppColors.border),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            BookCoverBlock(
                              title: book.title,
                              colorIndex: book.coverColorIndex,
                              width: 120,
                              height: 100,
                            ),
                            const SizedBox(height: AppSpacing.xs),
                            Text(
                              book.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context).textTheme.labelMedium,
                            ),
                            Text(
                              'NT\$${listing.price.toStringAsFixed(0)}',
                              style: Theme.of(context)
                                  .textTheme
                                  .titleSmall
                                  ?.copyWith(color: AppColors.accentDark),
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
        ),
        if (featuredPost != null) ...[
          const SizedBox(height: AppSpacing.lg),
          const _SectionHeader(title: '社群精選心得'),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.md),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(Icons.format_quote, color: AppColors.accent),
                        const SizedBox(width: AppSpacing.sm),
                        Expanded(
                          child: Text(featuredPost.title, style: Theme.of(context).textTheme.titleSmall),
                        ),
                      ],
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    Text(featuredPost.excerpt, style: Theme.of(context).textTheme.bodyMedium),
                    const SizedBox(height: AppSpacing.sm),
                    Text(
                      '— ${userProvider.getById(featuredPost.authorId)?.name ?? '書友'}',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, AppSpacing.sm),
      child: Text(title, style: Theme.of(context).textTheme.titleLarge),
    );
  }
}

class _EmptyHint extends StatelessWidget {
  const _EmptyHint({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Text(text, style: Theme.of(context).textTheme.bodyMedium),
      ),
    );
  }
}
