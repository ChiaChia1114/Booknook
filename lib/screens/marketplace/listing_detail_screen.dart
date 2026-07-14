import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/marketplace_listing.dart';
import '../../providers/library_provider.dart';
import '../../providers/marketplace_provider.dart';
import '../../providers/user_provider.dart';
import '../../theme/colors.dart';
import '../../theme/spacing.dart';
import '../../widgets/common/book_cover_block.dart';
import '../../widgets/common/condition_tag.dart';
import '../../widgets/common/user_avatar.dart';

class ListingDetailScreen extends StatelessWidget {
  const ListingDetailScreen({super.key, required this.listingId});

  final String listingId;

  @override
  Widget build(BuildContext context) {
    final marketplaceProvider = context.watch<MarketplaceProvider>();
    final libraryProvider = context.watch<LibraryProvider>();
    final userProvider = context.watch<UserProvider>();

    MarketplaceListing? listing;
    for (final l in marketplaceProvider.listings) {
      if (l.id == listingId) {
        listing = l;
        break;
      }
    }

    if (listing == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('商品詳情')),
        body: const Center(child: Text('找不到這個商品')),
      );
    }

    final book = libraryProvider.getBookById(listing.bookId);
    final seller = userProvider.getById(listing.sellerId);
    final isSold = listing.status == ListingStatus.sold;

    return Scaffold(
      appBar: AppBar(
        title: const Text('商品詳情'),
        actions: [
          IconButton(
            tooltip: listing.isFavorited ? '取消收藏' : '加入收藏',
            onPressed: () =>
                context.read<MarketplaceProvider>().toggleFavorite(listing!.id),
            icon: AnimatedSwitcher(
              duration: const Duration(milliseconds: 220),
              transitionBuilder: (child, animation) =>
                  ScaleTransition(scale: animation, child: child),
              child: Icon(
                listing.isFavorited ? Icons.favorite : Icons.favorite_border,
                key: ValueKey(listing.isFavorited),
                color: listing.isFavorited
                    ? AppColors.danger
                    : AppColors.textPrimary,
              ),
            ),
          ),
        ],
      ),
      body: book == null
          ? const Center(child: Text('找不到這本書的資料'))
          : SingleChildScrollView(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Center(
                    child: Stack(
                      children: [
                        BookCoverBlock(
                          title: book.title,
                          author: book.author,
                          colorIndex: book.coverColorIndex,
                          width: 160,
                          height: 224,
                        ),
                        if (isSold)
                          Positioned.fill(
                            child: Container(
                              decoration: BoxDecoration(
                                color: Colors.black.withValues(alpha: 0.45),
                                borderRadius: BorderRadius.circular(
                                  AppRadius.cardRadius,
                                ),
                              ),
                              alignment: Alignment.center,
                              child: const Text(
                                '已售出',
                                style: TextStyle(
                                  color: Colors.white,
                                  fontWeight: FontWeight.w700,
                                  fontSize: 20,
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  Text(
                    book.title,
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    book.author,
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                  const SizedBox(height: AppSpacing.md),
                  Row(
                    children: [
                      Text(
                        'NT\$ ${listing.price.toStringAsFixed(0)}',
                        style: Theme.of(context).textTheme.headlineSmall
                            ?.copyWith(color: AppColors.accentDark),
                      ),
                      const SizedBox(width: AppSpacing.md),
                      ConditionTag(label: listing.condition.label),
                    ],
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  if (seller != null) ...[
                    Text('賣家資訊', style: Theme.of(context).textTheme.titleSmall),
                    const SizedBox(height: AppSpacing.sm),
                    Row(
                      children: [
                        UserAvatar(
                          name: seller.name,
                          avatarColorIndex: seller.avatarColorIndex,
                        ),
                        const SizedBox(width: AppSpacing.sm),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              seller.name,
                              style: Theme.of(context).textTheme.bodyMedium,
                            ),
                            Text(
                              '已上架 ${seller.listingsCount} 本二手書．讀過 ${seller.booksReadCount} 本',
                              style: Theme.of(context).textTheme.labelSmall,
                            ),
                          ],
                        ),
                      ],
                    ),
                    const SizedBox(height: AppSpacing.lg),
                  ],
                  Text('商品說明', style: Theme.of(context).textTheme.titleSmall),
                  const SizedBox(height: AppSpacing.sm),
                  Text(
                    listing.description,
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                  const SizedBox(height: AppSpacing.xl),
                ],
              ),
            ),
      bottomNavigationBar: book == null
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.md),
                child: ElevatedButton(
                  onPressed: isSold
                      ? null
                      : () {
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(content: Text('已送出聯絡賣家的訊息（模擬）')),
                          );
                        },
                  child: Text(isSold ? '已售出' : '聯絡賣家'),
                ),
              ),
            ),
    );
  }
}
