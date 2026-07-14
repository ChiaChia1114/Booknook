import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/book.dart';
import '../../models/marketplace_listing.dart';
import '../../models/reading_record.dart';
import '../../models/review.dart';
import '../../providers/library_provider.dart';
import '../../providers/marketplace_provider.dart';
import '../../providers/user_provider.dart';
import '../../theme/colors.dart';
import '../../theme/spacing.dart';
import '../../widgets/common/book_cover_block.dart';
import '../../widgets/common/condition_tag.dart';
import '../../widgets/common/healing_meter.dart';
import '../../widgets/common/mind_bending_meter.dart';
import '../../widgets/common/recommend_bar.dart';
import '../../widgets/common/user_avatar.dart';
import '../marketplace/listing_detail_screen.dart';
import '../marketplace/marketplace_screen.dart';

enum _ReviewSort { newest, mostHelpful }

class BookDetailScreen extends StatefulWidget {
  const BookDetailScreen({super.key, required this.bookId});

  final String bookId;

  @override
  State<BookDetailScreen> createState() => _BookDetailScreenState();
}

class _BookDetailData {
  const _BookDetailData({required this.summary, required this.reviews});

  final BookRatingSummary summary;
  final List<Review> reviews;
}

class _BookDetailScreenState extends State<BookDetailScreen> {
  late Future<_BookDetailData> _future;
  _ReviewSort _sort = _ReviewSort.newest;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<_BookDetailData> _load() async {
    final library = context.read<LibraryProvider>();
    final summary = await library.ratingSummaryForBook(widget.bookId);
    final reviews = await library.reviewsForBook(widget.bookId);
    return _BookDetailData(summary: summary, reviews: reviews);
  }

  void _reload() {
    if (!mounted) return;
    setState(() {
      _future = _load();
    });
  }

  void _openReviewSheet() {
    final library = context.read<LibraryProvider>();
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(AppRadius.cardRadius),
        ),
      ),
      builder: (sheetContext) {
        return _ReviewFormSheet(
          onSubmit: (healing, mindBending, tag, note) async {
            await library.addReview(
              bookId: widget.bookId,
              healingLevel: healing,
              mindBendingLevel: mindBending,
              recommendTag: tag,
              note: note,
            );
            if (sheetContext.mounted) Navigator.pop(sheetContext);
            _reload();
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final library = context.watch<LibraryProvider>();
    final marketplace = context.watch<MarketplaceProvider>();
    final book = library.getBookById(widget.bookId);

    if (book == null) {
      return Scaffold(
        appBar: AppBar(),
        body: const Center(child: Text('找不到這本書')),
      );
    }

    final record = library.recordForBook(widget.bookId);
    final listings = marketplace.listingsForBook(widget.bookId);

    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: Text(book.title, overflow: TextOverflow.ellipsis),
        ),
        body: FutureBuilder<_BookDetailData>(
          future: _future,
          builder: (context, snapshot) {
            if (!snapshot.hasData) {
              return const Center(child: CircularProgressIndicator());
            }
            final data = snapshot.data!;
            final sortedReviews = List<Review>.of(data.reviews);
            switch (_sort) {
              case _ReviewSort.newest:
                sortedReviews.sort(
                  (a, b) => b.createdAt.compareTo(a.createdAt),
                );
              case _ReviewSort.mostHelpful:
                sortedReviews.sort(
                  (a, b) => b.helpfulCount.compareTo(a.helpfulCount),
                );
            }

            return Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpacing.md,
                    AppSpacing.md,
                    AppSpacing.md,
                    0,
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      BookCoverBlock(
                        title: book.title,
                        author: book.author,
                        colorIndex: book.coverColorIndex,
                        width: 96,
                        height: 134,
                      ),
                      const SizedBox(width: AppSpacing.md),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              book.title,
                              style: Theme.of(context).textTheme.headlineSmall,
                            ),
                            const SizedBox(height: 4),
                            Text(
                              book.author,
                              style: Theme.of(context).textTheme.bodyMedium,
                            ),
                            const SizedBox(height: AppSpacing.sm),
                            _ActionButtons(
                              bookId: widget.bookId,
                              status: record?.status,
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: AppSpacing.md),
                TabBar(
                  tabs: [
                    const Tab(text: '簡介'),
                    Tab(text: '評論（${data.reviews.length}）'),
                    Tab(text: '二手（${listings.length}）'),
                  ],
                ),
                Expanded(
                  child: TabBarView(
                    children: [
                      _AboutTab(book: book, summary: data.summary),
                      _ReviewsTab(
                        reviews: sortedReviews,
                        sort: _sort,
                        onSortChanged: (sort) => setState(() => _sort = sort),
                        onHelpful: (review) async {
                          await library.markReviewHelpful(review.id);
                          _reload();
                        },
                      ),
                      _MarketplaceTab(
                        bookId: widget.bookId,
                        listings: listings,
                      ),
                    ],
                  ),
                ),
              ],
            );
          },
        ),
        bottomNavigationBar: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                onPressed: _openReviewSheet,
                icon: const Icon(Icons.edit_outlined),
                label: const Text('寫下你的評價'),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _AboutTab extends StatelessWidget {
  const _AboutTab({required this.book, required this.summary});

  final Book book;
  final BookRatingSummary summary;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md,
        AppSpacing.md,
        AppSpacing.md,
        100,
      ),
      children: [
        _RatingCard(summary: summary),
        const SizedBox(height: AppSpacing.lg),
        Text('關於這本書', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: AppSpacing.sm),
        Text(book.description, style: Theme.of(context).textTheme.bodyLarge),
      ],
    );
  }
}

class _ReviewsTab extends StatelessWidget {
  const _ReviewsTab({
    required this.reviews,
    required this.sort,
    required this.onSortChanged,
    required this.onHelpful,
  });

  final List<Review> reviews;
  final _ReviewSort sort;
  final ValueChanged<_ReviewSort> onSortChanged;
  final ValueChanged<Review> onHelpful;

  @override
  Widget build(BuildContext context) {
    if (reviews.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Text(
            '還沒有人寫心得，當第一個分享的人吧！',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        ),
      );
    }
    return ListView(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md,
        AppSpacing.md,
        AppSpacing.md,
        100,
      ),
      children: [
        Row(
          children: [
            ChoiceChip(
              label: const Text('最新'),
              selected: sort == _ReviewSort.newest,
              onSelected: (_) => onSortChanged(_ReviewSort.newest),
            ),
            const SizedBox(width: AppSpacing.sm),
            ChoiceChip(
              label: const Text('最多幫助'),
              selected: sort == _ReviewSort.mostHelpful,
              onSelected: (_) => onSortChanged(_ReviewSort.mostHelpful),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        for (final review in reviews)
          _ReviewCard(review: review, onHelpful: () => onHelpful(review)),
      ],
    );
  }
}

class _MarketplaceTab extends StatelessWidget {
  const _MarketplaceTab({required this.bookId, required this.listings});

  final String bookId;
  final List<MarketplaceListing> listings;

  @override
  Widget build(BuildContext context) {
    if (listings.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Text(
            '目前沒有這本書的二手在售',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        ),
      );
    }
    return ListView(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md,
        AppSpacing.md,
        AppSpacing.md,
        100,
      ),
      children: [
        for (final listing in listings) _ListingRow(listing: listing),
        const SizedBox(height: AppSpacing.sm),
        OutlinedButton(
          onPressed: () => Navigator.push(
            context,
            MaterialPageRoute(
              builder: (_) => MarketplaceScreen(filterBookId: bookId),
            ),
          ),
          child: const Text('在市集查看全部'),
        ),
      ],
    );
  }
}

class _ListingRow extends StatelessWidget {
  const _ListingRow({required this.listing});

  final MarketplaceListing listing;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.cardRadius),
        onTap: () => Navigator.push(
          context,
          MaterialPageRoute(
            builder: (_) => ListingDetailScreen(listingId: listing.id),
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.sm),
          child: Row(
            children: [
              ConditionTag(label: listing.condition.label),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(
                  'NT\$ ${listing.price.toStringAsFixed(0)}',
                  style: Theme.of(
                    context,
                  ).textTheme.titleSmall?.copyWith(color: AppColors.accentDark),
                ),
              ),
              Icon(Icons.chevron_right, color: AppColors.textSecondary),
            ],
          ),
        ),
      ),
    );
  }
}

class _RatingCard extends StatelessWidget {
  const _RatingCard({required this.summary});

  final BookRatingSummary summary;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('社群平均評價', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: AppSpacing.sm),
            Row(
              children: [
                const SizedBox(width: 72, child: Text('療癒程度')),
                Expanded(
                  child: HealingMeter(value: summary.averageHealingLevel),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.xs),
            Row(
              children: [
                const SizedBox(width: 72, child: Text('燒腦程度')),
                Expanded(
                  child: MindBendingMeter(
                    value: summary.averageMindBendingLevel,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            Row(
              children: [
                const SizedBox(width: 72, child: Text('推薦度')),
                Expanded(
                  child: RecommendBar(
                    percent: summary.recommendPercent.toDouble(),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              '共 ${summary.reviewCount} 則評價',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}

class _ActionButtons extends StatelessWidget {
  const _ActionButtons({required this.bookId, required this.status});

  final String bookId;
  final ReadingStatus? status;

  @override
  Widget build(BuildContext context) {
    final library = context.read<LibraryProvider>();
    return Row(
      children: [
        Expanded(
          child: OutlinedButton.icon(
            onPressed: () =>
                library.setReadingStatus(bookId, ReadingStatus.wantToRead),
            icon: Icon(
              status == ReadingStatus.wantToRead
                  ? Icons.bookmark
                  : Icons.bookmark_outline,
            ),
            label: Text(status == ReadingStatus.wantToRead ? '已加入想讀' : '加入想讀'),
          ),
        ),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: ElevatedButton.icon(
            onPressed: () =>
                library.setReadingStatus(bookId, ReadingStatus.finished),
            icon: Icon(
              status == ReadingStatus.finished
                  ? Icons.check_circle
                  : Icons.check_circle_outline,
            ),
            label: Text(status == ReadingStatus.finished ? '已讀過了' : '標記讀過了'),
          ),
        ),
      ],
    );
  }
}

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({required this.review, required this.onHelpful});

  final Review review;
  final VoidCallback onHelpful;

  @override
  Widget build(BuildContext context) {
    final user = context.watch<UserProvider>().getById(review.userId);
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                UserAvatar(
                  name: user?.name ?? '',
                  avatarColorIndex: user?.avatarColorIndex ?? 0,
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Text(
                    user?.name ?? '匿名讀者',
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ),
                ConditionTag(label: review.recommendTag.label),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: AppSpacing.md,
              runSpacing: 4,
              children: [
                HealingMeter(value: review.healingLevel, iconSize: 14),
                MindBendingMeter(value: review.mindBendingLevel, iconSize: 14),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            Text(review.note, style: Theme.of(context).textTheme.bodyMedium),
            const SizedBox(height: AppSpacing.xs),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                onPressed: onHelpful,
                icon: const Icon(Icons.thumb_up_outlined, size: 16),
                label: Text('有幫助 ${review.helpfulCount}'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ReviewFormSheet extends StatefulWidget {
  const _ReviewFormSheet({required this.onSubmit});

  final Future<void> Function(
    double healing,
    double mindBending,
    RecommendTag tag,
    String note,
  )
  onSubmit;

  @override
  State<_ReviewFormSheet> createState() => _ReviewFormSheetState();
}

class _ReviewFormSheetState extends State<_ReviewFormSheet> {
  double _healing = 3;
  double _mindBending = 2;
  RecommendTag _tag = RecommendTag.worthReading;
  final TextEditingController _noteController = TextEditingController();
  bool _submitting = false;

  @override
  void dispose() {
    _noteController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_noteController.text.trim().isEmpty) return;
    setState(() => _submitting = true);
    await widget.onSubmit(
      _healing,
      _mindBending,
      _tag,
      _noteController.text.trim(),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: AppSpacing.md,
        right: AppSpacing.md,
        top: AppSpacing.md,
        bottom: MediaQuery.of(context).viewInsets.bottom + AppSpacing.md,
      ),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('寫下你的評價', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: AppSpacing.md),
            Text(
              '療癒程度：${_healing.toStringAsFixed(1)}',
              style: Theme.of(context).textTheme.labelLarge,
            ),
            Slider(
              value: _healing,
              min: 0,
              max: 5,
              divisions: 10,
              label: _healing.toStringAsFixed(1),
              onChanged: (v) => setState(() => _healing = v),
            ),
            Text(
              '燒腦程度：${_mindBending.toStringAsFixed(1)}',
              style: Theme.of(context).textTheme.labelLarge,
            ),
            Slider(
              value: _mindBending,
              min: 0,
              max: 5,
              divisions: 10,
              label: _mindBending.toStringAsFixed(1),
              onChanged: (v) => setState(() => _mindBending = v),
            ),
            const SizedBox(height: AppSpacing.sm),
            Text('推薦標籤', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: AppSpacing.xs),
            Wrap(
              spacing: AppSpacing.sm,
              children: [
                for (final tag in RecommendTag.values)
                  ChoiceChip(
                    label: Text(tag.label),
                    selected: _tag == tag,
                    onSelected: (_) => setState(() => _tag = tag),
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
            TextField(
              controller: _noteController,
              maxLines: 4,
              decoration: const InputDecoration(hintText: '分享你的閱讀心得⋯'),
            ),
            const SizedBox(height: AppSpacing.md),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: _submitting ? null : _submit,
                child: _submitting
                    ? const SizedBox(
                        height: 18,
                        width: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : const Text('送出評價'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
