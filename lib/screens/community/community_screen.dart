import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../models/community_post.dart';
import '../../providers/community_provider.dart';
import '../../providers/library_provider.dart';
import '../../providers/user_provider.dart';
import '../../theme/colors.dart';
import '../../theme/spacing.dart';
import '../../widgets/common/category_chip.dart';
import '../../widgets/common/condition_tag.dart';
import '../book_detail/book_detail_screen.dart';

class CommunityScreen extends StatefulWidget {
  const CommunityScreen({super.key});

  @override
  State<CommunityScreen> createState() => _CommunityScreenState();
}

class _CommunityScreenState extends State<CommunityScreen> {
  bool _sortByPopular = false;

  @override
  Widget build(BuildContext context) {
    final community = context.watch<CommunityProvider>();
    final library = context.watch<LibraryProvider>();
    final userProvider = context.watch<UserProvider>();

    final isLoading = community.isLoading || library.isLoading || userProvider.isLoading;

    final posts = List<CommunityPost>.of(community.posts);
    if (_sortByPopular) {
      posts.sort((a, b) => b.replyCount.compareTo(a.replyCount));
    }

    return Scaffold(
      appBar: AppBar(title: const Text('社群')),
      body: isLoading
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpacing.md,
                    AppSpacing.sm,
                    AppSpacing.md,
                    AppSpacing.sm,
                  ),
                  child: Row(
                    children: [
                      CategoryChip(
                        label: '最新',
                        selected: !_sortByPopular,
                        onTap: () => setState(() => _sortByPopular = false),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      CategoryChip(
                        label: '熱門',
                        selected: _sortByPopular,
                        onTap: () => setState(() => _sortByPopular = true),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: posts.isEmpty
                      ? Center(
                          child: Text('目前還沒有討論串', style: Theme.of(context).textTheme.bodyMedium),
                        )
                      : ListView.separated(
                          padding: const EdgeInsets.symmetric(
                            horizontal: AppSpacing.md,
                            vertical: AppSpacing.sm,
                          ),
                          itemCount: posts.length,
                          separatorBuilder: (_, _) => const SizedBox(height: AppSpacing.sm),
                          itemBuilder: (context, index) {
                            final post = posts[index];
                            final author = userProvider.getById(post.authorId);
                            final book = post.bookId == null ? null : library.getBookById(post.bookId!);
                            return _PostCard(
                              post: post,
                              authorName: author?.name ?? '書友',
                              bookTitle: book?.title,
                            );
                          },
                        ),
                ),
              ],
            ),
    );
  }
}

class _PostCard extends StatelessWidget {
  const _PostCard({required this.post, required this.authorName, this.bookTitle});

  final CommunityPost post;
  final String authorName;
  final String? bookTitle;

  String _formatTime(DateTime time) => DateFormat('MM/dd HH:mm').format(time);

  @override
  Widget build(BuildContext context) {
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.cardRadius),
        onTap: post.bookId == null
            ? null
            : () => Navigator.push(
                  context,
                  MaterialPageRoute(builder: (_) => BookDetailScreen(bookId: post.bookId!)),
                ),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(post.title, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: AppSpacing.xs),
              Text(
                post.excerpt,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: AppSpacing.sm),
              if (bookTitle != null) ...[
                ConditionTag(label: bookTitle!),
                const SizedBox(height: AppSpacing.sm),
              ],
              Row(
                children: [
                  Flexible(
                    child: Text(
                      authorName,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  const Icon(Icons.chat_bubble_outline, size: 14, color: AppColors.textSecondary),
                  const SizedBox(width: 2),
                  Text('${post.replyCount} 則回覆', style: Theme.of(context).textTheme.labelSmall),
                  const Spacer(),
                  Text(_formatTime(post.lastActiveAt), style: Theme.of(context).textTheme.labelSmall),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
