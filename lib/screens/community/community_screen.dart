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
import '../../widgets/common/empty_state.dart';
import '../../widgets/common/responsive_content.dart';
import 'post_detail_screen.dart';

class CommunityScreen extends StatefulWidget {
  const CommunityScreen({super.key});

  @override
  State<CommunityScreen> createState() => _CommunityScreenState();
}

class _CommunityScreenState extends State<CommunityScreen> {
  bool _sortByPopular = false;

  void _openNewPostSheet(BuildContext context) {
    final community = context.read<CommunityProvider>();
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(AppRadius.cardRadius),
        ),
      ),
      builder: (sheetContext) {
        return _NewPostSheet(
          onSubmit: (title, excerpt) async {
            await community.addPost(title: title, excerpt: excerpt);
            if (sheetContext.mounted) Navigator.pop(sheetContext);
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final community = context.watch<CommunityProvider>();
    final library = context.watch<LibraryProvider>();
    final userProvider = context.watch<UserProvider>();

    final isLoading =
        community.isLoading || library.isLoading || userProvider.isLoading;

    final posts = List<CommunityPost>.of(community.posts);
    if (_sortByPopular) {
      posts.sort((a, b) => b.replyCount.compareTo(a.replyCount));
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('社群'),
        actions: [
          IconButton(
            tooltip: '發表新話題',
            onPressed: () => _openNewPostSheet(context),
            icon: const Icon(Icons.add_circle_outline),
          ),
          const SizedBox(width: AppSpacing.sm),
        ],
      ),
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
                      ? const Center(
                          child: EmptyState(message: '目前還沒有討論串，來發表第一則話題吧！'),
                        )
                      : ResponsiveContent(
                          child: ListView.separated(
                            padding: const EdgeInsets.symmetric(
                              horizontal: AppSpacing.md,
                              vertical: AppSpacing.sm,
                            ),
                            itemCount: posts.length,
                            separatorBuilder: (_, _) =>
                                const SizedBox(height: AppSpacing.sm),
                            itemBuilder: (context, index) {
                              final post = posts[index];
                              final author = userProvider.getById(
                                post.authorId,
                              );
                              final book = post.bookId == null
                                  ? null
                                  : library.getBookById(post.bookId!);
                              return _PostCard(
                                post: post,
                                authorName: author?.name ?? '書友',
                                bookTitle: book?.title,
                              );
                            },
                          ),
                        ),
                ),
              ],
            ),
    );
  }
}

class _PostCard extends StatelessWidget {
  const _PostCard({
    required this.post,
    required this.authorName,
    this.bookTitle,
  });

  final CommunityPost post;
  final String authorName;
  final String? bookTitle;

  String _formatTime(DateTime time) => DateFormat('MM/dd HH:mm').format(time);

  @override
  Widget build(BuildContext context) {
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.cardRadius),
        onTap: () => Navigator.push(
          context,
          MaterialPageRoute(builder: (_) => PostDetailScreen(postId: post.id)),
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
                  Icon(
                    Icons.chat_bubble_outline,
                    size: 14,
                    color: AppColors.textSecondary,
                  ),
                  const SizedBox(width: 2),
                  Text(
                    '${post.replyCount} 則回覆',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                  const Spacer(),
                  Text(
                    _formatTime(post.lastActiveAt),
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _NewPostSheet extends StatefulWidget {
  const _NewPostSheet({required this.onSubmit});

  final Future<void> Function(String title, String excerpt) onSubmit;

  @override
  State<_NewPostSheet> createState() => _NewPostSheetState();
}

class _NewPostSheetState extends State<_NewPostSheet> {
  final TextEditingController _titleController = TextEditingController();
  final TextEditingController _excerptController = TextEditingController();
  bool _submitting = false;

  @override
  void dispose() {
    _titleController.dispose();
    _excerptController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_titleController.text.trim().isEmpty ||
        _excerptController.text.trim().isEmpty) {
      return;
    }
    setState(() => _submitting = true);
    await widget.onSubmit(
      _titleController.text.trim(),
      _excerptController.text.trim(),
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
            Text('發表新話題', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: AppSpacing.md),
            TextField(
              controller: _titleController,
              decoration: const InputDecoration(hintText: '標題'),
            ),
            const SizedBox(height: AppSpacing.md),
            TextField(
              controller: _excerptController,
              maxLines: 4,
              decoration: const InputDecoration(hintText: '想跟大家聊聊什麼呢？'),
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
                    : const Text('發表'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
