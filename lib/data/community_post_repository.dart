import 'package:uuid/uuid.dart';

import '../models/community_post.dart';
import 'mock_seed_data.dart';

abstract class CommunityPostRepository {
  Future<List<CommunityPost>> getAll();
  Future<List<CommunityPost>> getByBookId(String bookId);
  Future<CommunityPost> addPost({
    String? bookId,
    required String authorId,
    required String title,
    required String excerpt,
  });
}

class InMemoryCommunityPostRepository implements CommunityPostRepository {
  final List<CommunityPost> _posts = List.of(seedCommunityPosts);
  final Uuid _uuid = const Uuid();

  @override
  Future<List<CommunityPost>> getAll() async {
    return List.of(_posts)..sort((a, b) => b.lastActiveAt.compareTo(a.lastActiveAt));
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
    return post;
  }
}
