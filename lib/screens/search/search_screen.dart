import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/book.dart';
import '../../models/community_post.dart';
import '../../models/marketplace_listing.dart';
import '../../providers/community_provider.dart';
import '../../providers/library_provider.dart';
import '../../providers/marketplace_provider.dart';
import '../../theme/colors.dart';
import '../../theme/spacing.dart';
import '../../widgets/common/book_cover_block.dart';
import '../../widgets/common/condition_tag.dart';
import '../../widgets/common/responsive_content.dart';
import '../book_detail/book_detail_screen.dart';
import '../community/post_detail_screen.dart';
import '../marketplace/listing_detail_screen.dart';

class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key});

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final TextEditingController _controller = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final library = context.watch<LibraryProvider>();
    final community = context.watch<CommunityProvider>();
    final marketplace = context.watch<MarketplaceProvider>();

    final normalized = _query.trim().toLowerCase();
    final hasQuery = normalized.isNotEmpty;

    final matchedBooks = !hasQuery
        ? const <Book>[]
        : library.books
              .where(
                (b) =>
                    b.title.toLowerCase().contains(normalized) ||
                    b.author.toLowerCase().contains(normalized) ||
                    b.isbn.contains(normalized),
              )
              .toList();

    final matchedPosts = !hasQuery
        ? const <CommunityPost>[]
        : community.posts
              .where(
                (p) =>
                    p.title.toLowerCase().contains(normalized) ||
                    p.excerpt.toLowerCase().contains(normalized),
              )
              .toList();

    final matchedListings = !hasQuery
        ? const <MarketplaceListing>[]
        : marketplace.availableListings.where((l) {
            final book = library.getBookById(l.bookId);
            if (book == null) return false;
            return book.title.toLowerCase().contains(normalized) ||
                book.author.toLowerCase().contains(normalized);
          }).toList();

    final totalResults =
        matchedBooks.length + matchedPosts.length + matchedListings.length;

    return Scaffold(
      appBar: AppBar(
        title: TextField(
          controller: _controller,
          autofocus: true,
          onChanged: (value) => setState(() => _query = value),
          decoration: const InputDecoration(
            hintText: '搜尋書籍、討論、二手書⋯',
            border: InputBorder.none,
          ),
        ),
      ),
      body: !hasQuery
          ? Center(
              child: Text(
                '輸入關鍵字，跨書籍、社群、市集搜尋',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            )
          : totalResults == 0
          ? Center(
              child: Text(
                '找不到符合「$_query」的結果',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            )
          : ResponsiveContent(
              child: ListView(
                padding: const EdgeInsets.all(AppSpacing.md),
                children: [
                  if (matchedBooks.isNotEmpty) ...[
                    _SectionLabel(text: '書籍（${matchedBooks.length}）'),
                    SizedBox(
                      height: 190,
                      child: ListView.separated(
                        scrollDirection: Axis.horizontal,
                        itemCount: matchedBooks.length,
                        separatorBuilder: (_, _) =>
                            const SizedBox(width: AppSpacing.sm),
                        itemBuilder: (context, index) {
                          final book = matchedBooks[index];
                          return GestureDetector(
                            onTap: () => Navigator.push(
                              context,
                              MaterialPageRoute(
                                builder: (_) =>
                                    BookDetailScreen(bookId: book.id),
                              ),
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
                  ],
                  if (matchedPosts.isNotEmpty) ...[
                    _SectionLabel(text: '討論（${matchedPosts.length}）'),
                    for (final post in matchedPosts)
                      Card(
                        margin: const EdgeInsets.only(bottom: AppSpacing.sm),
                        child: ListTile(
                          title: Text(
                            post.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          subtitle: Text(
                            post.excerpt,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          onTap: () => Navigator.push(
                            context,
                            MaterialPageRoute(
                              builder: (_) => PostDetailScreen(postId: post.id),
                            ),
                          ),
                        ),
                      ),
                    const SizedBox(height: AppSpacing.sm),
                  ],
                  if (matchedListings.isNotEmpty) ...[
                    _SectionLabel(text: '二手市集（${matchedListings.length}）'),
                    for (final listing in matchedListings)
                      _ListingResultTile(
                        listing: listing,
                        book: library.getBookById(listing.bookId)!,
                      ),
                  ],
                ],
              ),
            ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Text(text, style: Theme.of(context).textTheme.titleMedium),
    );
  }
}

class _ListingResultTile extends StatelessWidget {
  const _ListingResultTile({required this.listing, required this.book});

  final MarketplaceListing listing;
  final Book book;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: ListTile(
        leading: BookCoverBlock(
          title: book.title,
          colorIndex: book.coverColorIndex,
          width: 40,
          height: 56,
        ),
        title: Text(book.title, maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Row(
          children: [
            ConditionTag(label: listing.condition.label),
            const SizedBox(width: AppSpacing.sm),
            Text(
              'NT\$ ${listing.price.toStringAsFixed(0)}',
              style: Theme.of(
                context,
              ).textTheme.labelMedium?.copyWith(color: AppColors.accentDark),
            ),
          ],
        ),
        onTap: () => Navigator.push(
          context,
          MaterialPageRoute(
            builder: (_) => ListingDetailScreen(listingId: listing.id),
          ),
        ),
      ),
    );
  }
}
