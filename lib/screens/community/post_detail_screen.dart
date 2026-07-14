import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../models/community_comment.dart';
import '../../models/community_post.dart';
import '../../providers/community_provider.dart';
import '../../providers/library_provider.dart';
import '../../providers/user_provider.dart';
import '../../theme/colors.dart';
import '../../theme/spacing.dart';
import '../../widgets/common/condition_tag.dart';
import '../../widgets/common/user_avatar.dart';
import '../book_detail/book_detail_screen.dart';

class PostDetailScreen extends StatefulWidget {
  const PostDetailScreen({super.key, required this.postId});

  final String postId;

  @override
  State<PostDetailScreen> createState() => _PostDetailScreenState();
}

class _PostDetailScreenState extends State<PostDetailScreen> {
  final TextEditingController _commentController = TextEditingController();
  late Future<List<CommunityComment>> _commentsFuture;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _commentsFuture = context.read<CommunityProvider>().commentsForPost(
      widget.postId,
    );
  }

  @override
  void dispose() {
    _commentController.dispose();
    super.dispose();
  }

  Future<void> _submitComment() async {
    final content = _commentController.text.trim();
    if (content.isEmpty) return;
    setState(() => _submitting = true);
    await context.read<CommunityProvider>().addComment(
      postId: widget.postId,
      content: content,
    );
    if (!mounted) return;
    _commentController.clear();
    setState(() {
      _submitting = false;
      _commentsFuture = context.read<CommunityProvider>().commentsForPost(
        widget.postId,
      );
    });
  }

  String _formatTime(DateTime time) => DateFormat('MM/dd HH:mm').format(time);

  @override
  Widget build(BuildContext context) {
    final community = context.watch<CommunityProvider>();
    final library = context.watch<LibraryProvider>();
    final userProvider = context.watch<UserProvider>();

    CommunityPost? post;
    for (final p in community.posts) {
      if (p.id == widget.postId) {
        post = p;
        break;
      }
    }

    if (post == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('討論串')),
        body: const Center(child: Text('找不到這則討論')),
      );
    }

    final author = userProvider.getById(post.authorId);
    final book = post.bookId == null ? null : library.getBookById(post.bookId!);

    return Scaffold(
      appBar: AppBar(title: const Text('討論串')),
      body: Column(
        children: [
          Expanded(
            child: ListView(
              padding: const EdgeInsets.all(AppSpacing.md),
              children: [
                Row(
                  children: [
                    UserAvatar(
                      name: author?.name ?? '',
                      avatarColorIndex: author?.avatarColorIndex ?? 0,
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            author?.name ?? '書友',
                            style: Theme.of(context).textTheme.titleSmall,
                          ),
                          Text(
                            _formatTime(post.lastActiveAt),
                            style: Theme.of(context).textTheme.labelSmall,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.md),
                Text(
                  post.title,
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(height: AppSpacing.sm),
                Text(
                  post.excerpt,
                  style: Theme.of(context).textTheme.bodyLarge,
                ),
                if (book != null) ...[
                  const SizedBox(height: AppSpacing.md),
                  InkWell(
                    onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => BookDetailScreen(bookId: book.id),
                      ),
                    ),
                    child: ConditionTag(label: '📖 ${book.title}'),
                  ),
                ],
                const SizedBox(height: AppSpacing.lg),
                const Divider(),
                const SizedBox(height: AppSpacing.sm),
                Text(
                  '留言（${post.replyCount}）',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: AppSpacing.sm),
                FutureBuilder<List<CommunityComment>>(
                  future: _commentsFuture,
                  builder: (context, snapshot) {
                    if (!snapshot.hasData) {
                      return const Padding(
                        padding: EdgeInsets.symmetric(vertical: AppSpacing.lg),
                        child: Center(child: CircularProgressIndicator()),
                      );
                    }
                    final comments = snapshot.data!;
                    if (comments.isEmpty) {
                      return Padding(
                        padding: const EdgeInsets.symmetric(
                          vertical: AppSpacing.lg,
                        ),
                        child: Text(
                          '還沒有留言，來當第一個吧！',
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                      );
                    }
                    return Column(
                      children: [
                        for (final comment in comments)
                          _CommentTile(comment: comment),
                      ],
                    );
                  },
                ),
              ],
            ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _commentController,
                      decoration: const InputDecoration(hintText: '留下你的想法⋯'),
                      onSubmitted: (_) => _submitComment(),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  IconButton.filled(
                    onPressed: _submitting ? null : _submitComment,
                    icon: const Icon(Icons.send),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CommentTile extends StatelessWidget {
  const _CommentTile({required this.comment});

  final CommunityComment comment;

  String _formatTime(DateTime time) => DateFormat('MM/dd HH:mm').format(time);

  @override
  Widget build(BuildContext context) {
    final author = context.watch<UserProvider>().getById(comment.authorId);
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          UserAvatar(
            name: author?.name ?? '',
            avatarColorIndex: author?.avatarColorIndex ?? 0,
            radius: 14,
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      author?.name ?? '書友',
                      style: Theme.of(context).textTheme.labelLarge,
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Text(
                      _formatTime(comment.createdAt),
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  comment.content,
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
