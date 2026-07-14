import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../data/mock_seed_data.dart' show currentUserId;
import '../../models/book.dart';
import '../../models/reading_record.dart';
import '../../models/review.dart';
import '../../providers/library_provider.dart';
import '../../theme/spacing.dart';
import '../../widgets/common/book_cover_block.dart';
import '../../widgets/common/healing_meter.dart';
import '../../widgets/common/mind_bending_meter.dart';
import '../book_detail/book_detail_screen.dart';
import '../marketplace/sell_book_screen.dart';

class MyLibraryScreen extends StatefulWidget {
  const MyLibraryScreen({super.key});

  @override
  State<MyLibraryScreen> createState() => _MyLibraryScreenState();
}

class _MyLibraryScreenState extends State<MyLibraryScreen> {
  final TextEditingController _searchController = TextEditingController();
  List<Book>? _searchMatches;

  static const List<ReadingStatus> _statuses = [
    ReadingStatus.wantToRead,
    ReadingStatus.reading,
    ReadingStatus.finished,
  ];

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _onSearchChanged(String value) async {
    if (value.trim().isEmpty) {
      setState(() => _searchMatches = null);
      return;
    }
    final results = await context.read<LibraryProvider>().search(value);
    if (!mounted) return;
    setState(() => _searchMatches = results);
  }

  void _openBook(String bookId) {
    Navigator.push(
      context,
      MaterialPageRoute(builder: (_) => BookDetailScreen(bookId: bookId)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final libraryProvider = context.watch<LibraryProvider>();

    return DefaultTabController(
      length: _statuses.length,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('我的書櫃'),
          bottom: TabBar(
            tabs: [for (final status in _statuses) Tab(text: status.label)],
          ),
        ),
        body: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: TextField(
                controller: _searchController,
                onChanged: _onSearchChanged,
                decoration: InputDecoration(
                  hintText: '搜尋書名、作者',
                  prefixIcon: const Icon(Icons.search),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(AppRadius.buttonRadius),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
            ),
            Expanded(
              child: libraryProvider.isLoading
                  ? const Center(child: CircularProgressIndicator())
                  : TabBarView(
                      children: [
                        for (final status in _statuses)
                          _StatusTab(
                            status: status,
                            searchMatches: _searchMatches,
                            onOpenBook: _openBook,
                          ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatusTab extends StatelessWidget {
  const _StatusTab({
    required this.status,
    required this.searchMatches,
    required this.onOpenBook,
  });

  final ReadingStatus status;
  final List<Book>? searchMatches;
  final ValueChanged<String> onOpenBook;

  @override
  Widget build(BuildContext context) {
    final libraryProvider = context.watch<LibraryProvider>();
    final records = libraryProvider.recordsByStatus(status);
    final matchedIds = searchMatches?.map((b) => b.id).toSet();
    final filtered = matchedIds == null
        ? records
        : records.where((r) => matchedIds.contains(r.bookId)).toList();

    if (filtered.isEmpty) {
      return Center(
        child: Text(
          matchedIds == null ? '${status.label}的書櫃還是空的' : '找不到符合搜尋的書',
          style: Theme.of(context).textTheme.bodyMedium,
        ),
      );
    }

    return ListView.separated(
      padding: const EdgeInsets.all(AppSpacing.md),
      itemCount: filtered.length,
      separatorBuilder: (_, _) => const SizedBox(height: AppSpacing.sm),
      itemBuilder: (context, index) {
        final record = filtered[index];
        final book = libraryProvider.getBookById(record.bookId);
        if (book == null) return const SizedBox.shrink();
        return _LibraryBookCard(
          book: book,
          record: record,
          onTap: () => onOpenBook(book.id),
        );
      },
    );
  }
}

class _LibraryBookCard extends StatelessWidget {
  const _LibraryBookCard({
    required this.book,
    required this.record,
    required this.onTap,
  });

  final Book book;
  final ReadingRecord record;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.cardRadius),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.sm),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              BookCoverBlock(
                title: book.title,
                author: book.author,
                colorIndex: book.coverColorIndex,
                width: 64,
                height: 90,
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      book.title,
                      style: Theme.of(context).textTheme.titleSmall,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      book.author,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    _buildStatusExtra(context),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildStatusExtra(BuildContext context) {
    switch (record.status) {
      case ReadingStatus.wantToRead:
        return OutlinedButton(
          onPressed: () => context.read<LibraryProvider>().setReadingStatus(
            book.id,
            ReadingStatus.reading,
          ),
          child: const Text('開始閱讀'),
        );
      case ReadingStatus.reading:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (record.startedAt != null)
              Text(
                '開始閱讀：${_formatDate(record.startedAt!)}',
                style: Theme.of(context).textTheme.labelMedium,
              ),
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: AppSpacing.sm,
              runSpacing: AppSpacing.sm,
              children: [
                OutlinedButton(
                  onPressed: () => context
                      .read<LibraryProvider>()
                      .setReadingStatus(book.id, ReadingStatus.finished),
                  child: const Text('標記讀完'),
                ),
                TextButton(
                  onPressed: () => Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) => BookDetailScreen(bookId: book.id),
                    ),
                  ),
                  child: const Text('寫心得'),
                ),
              ],
            ),
          ],
        );
      case ReadingStatus.finished:
        return _FinishedExtra(book: book);
    }
  }

  String _formatDate(DateTime date) => '${date.year}/${date.month}/${date.day}';
}

class _FinishedExtra extends StatefulWidget {
  const _FinishedExtra({required this.book});

  final Book book;

  @override
  State<_FinishedExtra> createState() => _FinishedExtraState();
}

class _FinishedExtraState extends State<_FinishedExtra> {
  late final Future<List<Review>> _reviewsFuture = context
      .read<LibraryProvider>()
      .reviewsForBook(widget.book.id);

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        FutureBuilder<List<Review>>(
          future: _reviewsFuture,
          builder: (context, snapshot) {
            final myReview = snapshot.data
                ?.where((r) => r.userId == currentUserId)
                .toList();
            if (myReview == null || myReview.isEmpty) {
              return Text(
                '尚未寫下心得',
                style: Theme.of(context).textTheme.labelMedium,
              );
            }
            final review = myReview.first;
            return Row(
              children: [
                HealingMeter(
                  value: review.healingLevel,
                  iconSize: 14,
                  showLabel: false,
                ),
                const SizedBox(width: AppSpacing.sm),
                MindBendingMeter(
                  value: review.mindBendingLevel,
                  iconSize: 14,
                  showLabel: false,
                ),
              ],
            );
          },
        ),
        const SizedBox(height: AppSpacing.sm),
        OutlinedButton(
          onPressed: () => Navigator.push(
            context,
            MaterialPageRoute(
              builder: (_) => SellBookScreen(preselectedBookId: widget.book.id),
            ),
          ),
          child: const Text('上架二手書'),
        ),
      ],
    );
  }
}
