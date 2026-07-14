import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

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
import '../marketplace/marketplace_screen.dart';

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
        borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadius.cardRadius)),
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
    final listingCount = marketplace.listingsForBook(widget.bookId).length;

    return Scaffold(
      appBar: AppBar(title: Text(book.title, overflow: TextOverflow.ellipsis)),
      body: FutureBuilder<_BookDetailData>(
        future: _future,
        builder: (context, snapshot) {
          if (!snapshot.hasData) {
            return const Center(child: CircularProgressIndicator());
          }
          final data = snapshot.data!;
          return ListView(
            padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, 100),
            children: [
              Center(
                child: BookCoverBlock(
                  title: book.title,
                  author: book.author,
                  colorIndex: book.coverColorIndex,
                  width: 160,
                  height: 224,
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              Text(
                book.title,
                style: Theme.of(context).textTheme.headlineMedium,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 4),
              Text(
                book.author,
                style: Theme.of(context).textTheme.bodyMedium,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.lg),
              _RatingCard(summary: data.summary),
              const SizedBox(height: AppSpacing.md),
              _ActionButtons(bookId: widget.bookId, status: record?.status),
              const SizedBox(height: AppSpacing.md),
              _MarketplaceLink(bookId: widget.bookId, count: listingCount),
              const SizedBox(height: AppSpacing.lg),
              Text('關於這本書', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: AppSpacing.sm),
              Text(book.description, style: Theme.of(context).textTheme.bodyLarge),
              const SizedBox(height: AppSpacing.lg),
              Text('讀者評價（${data.reviews.length}）', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: AppSpacing.sm),
              if (data.reviews.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: AppSpacing.lg),
                  child: Text('還沒有人寫心得，當第一個分享的人吧！', style: Theme.of(context).textTheme.bodyMedium),
                )
              else
                for (final review in data.reviews)
                  _ReviewCard(
                    review: review,
                    onHelpful: () async {
                      await library.markReviewHelpful(review.id);
                      _reload();
                    },
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
                Expanded(child: HealingMeter(value: summary.averageHealingLevel)),
              ],
            ),
            const SizedBox(height: AppSpacing.xs),
            Row(
              children: [
                const SizedBox(width: 72, child: Text('燒腦程度')),
                Expanded(child: MindBendingMeter(value: summary.averageMindBendingLevel)),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            Row(
              children: [
                const SizedBox(width: 72, child: Text('推薦度')),
                Expanded(child: RecommendBar(percent: summary.recommendPercent.toDouble())),
              ],
            ),
            const SizedBox(height: AppSpacing.xs),
            Text('共 ${summary.reviewCount} 則評價', style: Theme.of(context).textTheme.bodySmall),
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
            onPressed: () => library.setReadingStatus(bookId, ReadingStatus.wantToRead),
            icon: Icon(status == ReadingStatus.wantToRead ? Icons.bookmark : Icons.bookmark_outline),
            label: Text(status == ReadingStatus.wantToRead ? '已加入想讀' : '加入想讀'),
          ),
        ),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: ElevatedButton.icon(
            onPressed: () => library.setReadingStatus(bookId, ReadingStatus.finished),
            icon: Icon(status == ReadingStatus.finished ? Icons.check_circle : Icons.check_circle_outline),
            label: Text(status == ReadingStatus.finished ? '已讀過了' : '標記讀過了'),
          ),
        ),
      ],
    );
  }
}

class _MarketplaceLink extends StatelessWidget {
  const _MarketplaceLink({required this.bookId, required this.count});

  final String bookId;
  final int count;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(AppRadius.cardRadius),
      onTap: () => Navigator.push(
        context,
        MaterialPageRoute(builder: (_) => MarketplaceScreen(filterBookId: bookId)),
      ),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm + AppSpacing.xs),
        decoration: BoxDecoration(
          color: AppColors.surfaceSubtle,
          borderRadius: BorderRadius.circular(AppRadius.cardRadius),
          border: Border.all(color: AppColors.border),
        ),
        child: Row(
          children: [
            const Icon(Icons.storefront_outlined, color: AppColors.accent),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Text(
                '二手市集．$count 本在售',
                style: Theme.of(context).textTheme.titleSmall,
              ),
            ),
            const Icon(Icons.chevron_right, color: AppColors.textSecondary),
          ],
        ),
      ),
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
                UserAvatar(name: user?.name ?? '', avatarColorIndex: user?.avatarColorIndex ?? 0),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Text(user?.name ?? '匿名讀者', style: Theme.of(context).textTheme.titleSmall),
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
  ) onSubmit;

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
    await widget.onSubmit(_healing, _mindBending, _tag, _noteController.text.trim());
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
            Text('療癒程度：${_healing.toStringAsFixed(1)}', style: Theme.of(context).textTheme.labelLarge),
            Slider(
              value: _healing,
              min: 0,
              max: 5,
              divisions: 10,
              label: _healing.toStringAsFixed(1),
              onChanged: (v) => setState(() => _healing = v),
            ),
            Text('燒腦程度：${_mindBending.toStringAsFixed(1)}', style: Theme.of(context).textTheme.labelLarge),
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
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
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
