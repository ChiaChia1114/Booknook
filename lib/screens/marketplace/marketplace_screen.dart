import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/book.dart';
import '../../models/marketplace_listing.dart';
import '../../providers/library_provider.dart';
import '../../providers/marketplace_provider.dart';
import '../../theme/colors.dart';
import '../../theme/spacing.dart';
import '../../widgets/common/book_cover_block.dart';
import '../../widgets/common/category_chip.dart';
import '../../widgets/common/condition_tag.dart';
import '../../widgets/common/empty_state.dart';
import '../../utils/page_transitions.dart';
import 'listing_detail_screen.dart';
import 'sell_book_screen.dart';

const String _allGenres = '全部';

enum _SortOrder { newest, priceLowHigh, priceHighLow }

extension on _SortOrder {
  String get label {
    switch (this) {
      case _SortOrder.newest:
        return '最新上架';
      case _SortOrder.priceLowHigh:
        return '價格：低到高';
      case _SortOrder.priceHighLow:
        return '價格：高到低';
    }
  }
}

class MarketplaceScreen extends StatefulWidget {
  const MarketplaceScreen({
    super.key,
    this.filterBookId,
    this.onlyMine = false,
  });

  final String? filterBookId;
  final bool onlyMine;

  @override
  State<MarketplaceScreen> createState() => _MarketplaceScreenState();
}

class _MarketplaceScreenState extends State<MarketplaceScreen> {
  final TextEditingController _searchController = TextEditingController();
  String _query = '';
  String _selectedGenre = _allGenres;
  String? _filterBookId;
  _SortOrder _sort = _SortOrder.newest;
  bool _favoritesOnly = false;

  @override
  void initState() {
    super.initState();
    _filterBookId = widget.filterBookId;
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final marketplaceProvider = context.watch<MarketplaceProvider>();
    final libraryProvider = context.watch<LibraryProvider>();

    Book? bookFor(String bookId) => libraryProvider.getBookById(bookId);

    List<MarketplaceListing> listings = widget.onlyMine
        ? marketplaceProvider.myListings
        : marketplaceProvider.availableListings;

    if (_filterBookId != null) {
      listings = listings.where((l) => l.bookId == _filterBookId).toList();
    }

    final genres = <String>{
      for (final l in listings)
        if (bookFor(l.bookId) != null) bookFor(l.bookId)!.genre,
    }.toList()..sort();

    if (_selectedGenre != _allGenres && genres.contains(_selectedGenre)) {
      listings = listings
          .where((l) => bookFor(l.bookId)?.genre == _selectedGenre)
          .toList();
    }

    if (_query.trim().isNotEmpty) {
      final normalized = _query.trim().toLowerCase();
      listings = listings.where((l) {
        final book = bookFor(l.bookId);
        if (book == null) return false;
        return book.title.toLowerCase().contains(normalized) ||
            book.author.toLowerCase().contains(normalized) ||
            book.isbn.contains(normalized);
      }).toList();
    }

    if (_favoritesOnly) {
      listings = listings.where((l) => l.isFavorited).toList();
    }

    listings = List.of(listings);
    switch (_sort) {
      case _SortOrder.newest:
        listings.sort((a, b) => b.createdAt.compareTo(a.createdAt));
      case _SortOrder.priceLowHigh:
        listings.sort((a, b) => a.price.compareTo(b.price));
      case _SortOrder.priceHighLow:
        listings.sort((a, b) => b.price.compareTo(a.price));
    }

    final filterBook = _filterBookId != null ? bookFor(_filterBookId!) : null;

    return Scaffold(
      appBar: AppBar(
        title: const Text('市集'),
        actions: [
          IconButton(
            tooltip: '只看收藏',
            onPressed: () => setState(() => _favoritesOnly = !_favoritesOnly),
            icon: Icon(
              _favoritesOnly ? Icons.favorite : Icons.favorite_border,
              color: _favoritesOnly ? AppColors.danger : null,
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(right: AppSpacing.md),
            child: OutlinedButton(
              onPressed: () => Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => const SellBookScreen()),
              ),
              child: const Text('＋ 賣書'),
            ),
          ),
        ],
      ),
      body: marketplaceProvider.isLoading || libraryProvider.isLoading
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpacing.md,
                    AppSpacing.sm,
                    AppSpacing.md,
                    0,
                  ),
                  child: Text(
                    '書窩．二手市集',
                    style: Theme.of(context).textTheme.labelMedium,
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.all(AppSpacing.md),
                  child: TextField(
                    controller: _searchController,
                    onChanged: (value) => setState(() => _query = value),
                    decoration: InputDecoration(
                      hintText: '搜尋書名、作者、ISBN',
                      prefixIcon: const Icon(Icons.search),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(
                          AppRadius.buttonRadius,
                        ),
                        borderSide: BorderSide.none,
                      ),
                    ),
                  ),
                ),
                if (filterBook != null)
                  Padding(
                    padding: const EdgeInsets.only(
                      left: AppSpacing.md,
                      right: AppSpacing.md,
                      bottom: AppSpacing.sm,
                    ),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: InputChip(
                        label: Text('篩選中：《${filterBook.title}》'),
                        onDeleted: () => setState(() => _filterBookId = null),
                        deleteIcon: const Icon(Icons.close, size: 16),
                      ),
                    ),
                  ),
                SizedBox(
                  height: 44,
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.md,
                    ),
                    children: [
                      CategoryChip(
                        label: _allGenres,
                        selected: _selectedGenre == _allGenres,
                        onTap: () =>
                            setState(() => _selectedGenre = _allGenres),
                      ),
                      for (final genre in genres) ...[
                        const SizedBox(width: AppSpacing.sm),
                        CategoryChip(
                          label: genre,
                          selected: _selectedGenre == genre,
                          onTap: () => setState(() => _selectedGenre = genre),
                        ),
                      ],
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpacing.md,
                    AppSpacing.md,
                    AppSpacing.md,
                    AppSpacing.sm,
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          '共 ${listings.length} 本在售',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ),
                      PopupMenuButton<_SortOrder>(
                        initialValue: _sort,
                        onSelected: (order) => setState(() => _sort = order),
                        itemBuilder: (context) => [
                          for (final order in _SortOrder.values)
                            PopupMenuItem(
                              value: order,
                              child: Text(order.label),
                            ),
                        ],
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              Icons.sort,
                              size: 18,
                              color: AppColors.textSecondary,
                            ),
                            const SizedBox(width: 4),
                            Text(
                              _sort.label,
                              style: Theme.of(context).textTheme.labelMedium,
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: listings.isEmpty
                      ? const Center(
                          child: EmptyState(message: '目前沒有符合的商品，換個關鍵字或分類看看？'),
                        )
                      : GridView.builder(
                          padding: const EdgeInsets.fromLTRB(
                            AppSpacing.md,
                            0,
                            AppSpacing.md,
                            AppSpacing.md,
                          ),
                          gridDelegate:
                              const SliverGridDelegateWithMaxCrossAxisExtent(
                                maxCrossAxisExtent: 200,
                                mainAxisSpacing: AppSpacing.md,
                                crossAxisSpacing: AppSpacing.md,
                                childAspectRatio: 0.62,
                              ),
                          itemCount: listings.length,
                          itemBuilder: (context, index) {
                            final listing = listings[index];
                            final book = bookFor(listing.bookId);
                            if (book == null) return const SizedBox.shrink();
                            return _ListingCard(listing: listing, book: book);
                          },
                        ),
                ),
              ],
            ),
    );
  }
}

class _ListingCard extends StatelessWidget {
  const _ListingCard({required this.listing, required this.book});

  final MarketplaceListing listing;
  final Book book;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(AppRadius.cardRadius),
      onTap: () =>
          pushWithFade(context, ListingDetailScreen(listingId: listing.id)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: LayoutBuilder(
              builder: (context, constraints) {
                return Stack(
                  children: [
                    BookCoverBlock(
                      title: book.title,
                      author: book.author,
                      colorIndex: book.coverColorIndex,
                      width: constraints.maxWidth,
                      height: constraints.maxHeight,
                    ),
                    Positioned(
                      top: AppSpacing.sm,
                      left: AppSpacing.sm,
                      child: ConditionTag(label: listing.condition.label),
                    ),
                    Positioned(
                      top: AppSpacing.xs,
                      right: AppSpacing.xs,
                      child: _FavoriteButton(listing: listing),
                    ),
                  ],
                );
              },
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            book.title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.titleSmall,
          ),
          const SizedBox(height: 2),
          Text(
            'NT\$ ${listing.price.toStringAsFixed(0)}',
            style: Theme.of(
              context,
            ).textTheme.titleSmall?.copyWith(color: AppColors.accentDark),
          ),
        ],
      ),
    );
  }
}

class _FavoriteButton extends StatelessWidget {
  const _FavoriteButton({required this.listing});

  final MarketplaceListing listing;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: listing.isFavorited ? '取消收藏' : '加入收藏',
      child: GestureDetector(
        onTap: () =>
            context.read<MarketplaceProvider>().toggleFavorite(listing.id),
        child: Container(
          padding: const EdgeInsets.all(4),
          decoration: BoxDecoration(
            color: AppColors.surface,
            shape: BoxShape.circle,
          ),
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 220),
            transitionBuilder: (child, animation) =>
                ScaleTransition(scale: animation, child: child),
            child: Icon(
              listing.isFavorited ? Icons.favorite : Icons.favorite_border,
              key: ValueKey(listing.isFavorited),
              size: 18,
              color: listing.isFavorited
                  ? AppColors.danger
                  : AppColors.textSecondary,
            ),
          ),
        ),
      ),
    );
  }
}
