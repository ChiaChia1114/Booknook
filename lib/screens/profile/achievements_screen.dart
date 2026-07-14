import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/reading_record.dart';
import '../../models/review.dart';
import '../../providers/library_provider.dart';
import '../../providers/marketplace_provider.dart';
import '../../theme/colors.dart';
import '../../theme/spacing.dart';

class _Achievement {
  const _Achievement({
    required this.icon,
    required this.title,
    required this.description,
    required this.progress,
    required this.target,
  });

  final IconData icon;
  final String title;
  final String description;
  final int progress;
  final int target;

  bool get isUnlocked => progress >= target;
  double get fraction =>
      target == 0 ? 1 : (progress / target).clamp(0, 1).toDouble();
}

class AchievementsScreen extends StatefulWidget {
  const AchievementsScreen({super.key});

  @override
  State<AchievementsScreen> createState() => _AchievementsScreenState();
}

class _AchievementsScreenState extends State<AchievementsScreen> {
  late final Future<List<Review>> _myReviewsFuture = context
      .read<LibraryProvider>()
      .myReviews();

  @override
  Widget build(BuildContext context) {
    final library = context.watch<LibraryProvider>();
    final marketplace = context.watch<MarketplaceProvider>();

    final wantToReadCount = library
        .recordsByStatus(ReadingStatus.wantToRead)
        .length;
    final finishedCount = library
        .recordsByStatus(ReadingStatus.finished)
        .length;
    final listingCount = marketplace.myListings.length;

    return Scaffold(
      appBar: AppBar(title: const Text('我的成就')),
      body: FutureBuilder<List<Review>>(
        future: _myReviewsFuture,
        builder: (context, snapshot) {
          if (!snapshot.hasData) {
            return const Center(child: CircularProgressIndicator());
          }
          final reviews = snapshot.data!;
          final reviewCount = reviews.length;
          final totalHelpful = reviews.fold<int>(
            0,
            (sum, r) => sum + r.helpfulCount,
          );

          final achievements = <_Achievement>[
            _Achievement(
              icon: Icons.bookmark_add_outlined,
              title: '初次翻閱',
              description: '將第一本書加入想讀清單',
              progress: wantToReadCount,
              target: 1,
            ),
            _Achievement(
              icon: Icons.menu_book,
              title: '讀完第一本',
              description: '完成第一本書的閱讀',
              progress: finishedCount,
              target: 1,
            ),
            _Achievement(
              icon: Icons.nightlight_round,
              title: '深夜書蟲',
              description: '累積讀完 5 本書',
              progress: finishedCount,
              target: 5,
            ),
            _Achievement(
              icon: Icons.auto_stories,
              title: '藏書家',
              description: '累積讀完 15 本書',
              progress: finishedCount,
              target: 15,
            ),
            _Achievement(
              icon: Icons.rate_review_outlined,
              title: '心得達人',
              description: '寫下 3 篇讀書心得',
              progress: reviewCount,
              target: 3,
            ),
            _Achievement(
              icon: Icons.volunteer_activism_outlined,
              title: '熱心書友',
              description: '心得累積獲得 10 次「有幫助」',
              progress: totalHelpful,
              target: 10,
            ),
            _Achievement(
              icon: Icons.storefront_outlined,
              title: '市集新手',
              description: '上架第一本二手書',
              progress: listingCount,
              target: 1,
            ),
            _Achievement(
              icon: Icons.local_shipping_outlined,
              title: '市集老手',
              description: '累積上架 5 本二手書',
              progress: listingCount,
              target: 5,
            ),
          ];

          final unlockedCount = achievements.where((a) => a.isUnlocked).length;

          return ListView(
            padding: const EdgeInsets.all(AppSpacing.md),
            children: [
              Text(
                '已解鎖 $unlockedCount / ${achievements.length}',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: AppSpacing.md),
              GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                  maxCrossAxisExtent: 220,
                  mainAxisSpacing: AppSpacing.sm,
                  crossAxisSpacing: AppSpacing.sm,
                  childAspectRatio: 1.05,
                ),
                itemCount: achievements.length,
                itemBuilder: (context, index) =>
                    _AchievementCard(achievement: achievements[index]),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _AchievementCard extends StatelessWidget {
  const _AchievementCard({required this.achievement});

  final _Achievement achievement;

  @override
  Widget build(BuildContext context) {
    final unlocked = achievement.isUnlocked;
    return Card(
      color: unlocked ? AppColors.accentLight : AppColors.surfaceSubtle,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Icon(
                  achievement.icon,
                  color: unlocked
                      ? AppColors.accentDark
                      : AppColors.textSecondary,
                  size: 28,
                ),
                if (unlocked)
                  Icon(Icons.check_circle, color: AppColors.success, size: 18)
                else
                  Icon(
                    Icons.lock_outline,
                    color: AppColors.textSecondary,
                    size: 18,
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            Text(
              achievement.title,
              style: Theme.of(context).textTheme.titleSmall?.copyWith(
                color: unlocked
                    ? AppColors.textPrimary
                    : AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              achievement.description,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const Spacer(),
            ClipRRect(
              borderRadius: BorderRadius.circular(AppRadius.chipRadius),
              child: LinearProgressIndicator(
                value: achievement.fraction,
                minHeight: 6,
                backgroundColor: AppColors.border,
                valueColor: AlwaysStoppedAnimation<Color>(
                  unlocked ? AppColors.success : AppColors.accent,
                ),
              ),
            ),
            const SizedBox(height: 2),
            Text(
              '${achievement.progress.clamp(0, achievement.target)}/${achievement.target}',
              style: Theme.of(context).textTheme.labelSmall,
            ),
          ],
        ),
      ),
    );
  }
}
