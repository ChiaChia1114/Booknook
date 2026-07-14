import 'package:uuid/uuid.dart';

import '../models/community_post.dart';
import 'local_store.dart';
import 'mock_seed_data.dart';

const String _storeKey = 'community_posts';

abstract class CommunityPostRepository {
  Future<List<CommunityPost>> getAll();
  Future<List<CommunityPost>> getByBookId(String bookId);
  Future<CommunityPost> addPost({
    String? bookId,
    required String authorId,
    required String title,
    required String excerpt,
  });
  Future<CommunityPost> incrementReplyCount(String postId);
}

class InMemoryCommunityPostRepository implements CommunityPostRepository {
  InMemoryCommunityPostRepository()
    : _posts =
          LocalStore.readList(
            _storeKey,
          )?.map(CommunityPost.fromJson).toList() ??
          List.of(seedCommunityPosts);

  final List<CommunityPost> _posts;
  final Uuid _uuid = const Uuid();

  void _persist() =>
      LocalStore.writeList(_storeKey, _posts.map((p) => p.toJson()).toList());

  @override
  Future<List<CommunityPost>> getAll() async {
    return List.of(_posts)
      ..sort((a, b) => b.lastActiveAt.compareTo(a.lastActiveAt));
  }

  @override
  Future<List<CommunityPost>> getByBookId(String bookId) async {
    return _posts.where((p) => p.bookId == bookId).toList();
  }

  @override
  Future<CommunityPost> addPost({
    String? bookId,
    required String authorId,
    required String title,
    required String excerpt,
  }) async {
    final post = CommunityPost(
      id: _uuid.v4(),
      bookId: bookId,
      authorId: authorId,
      title: title,
      replyCount: 0,
      lastActiveAt: DateTime.now(),
      excerpt: excerpt,
    );
    _posts.add(post);
    _persist();
    return post;
  }

  @override
  Future<CommunityPost> incrementReplyCount(String postId) async {
    final index = _posts.indexWhere((p) => p.id == postId);
    if (index == -1) throw ArgumentError('Post $postId not found');
    final updated = _posts[index].copyWith(
      replyCount: _posts[index].replyCount + 1,
      lastActiveAt: DateTime.now(),
    );
    _posts[index] = updated;
    _persist();
    return updated;
  }
}
