import 'package:uuid/uuid.dart';

import '../models/community_comment.dart';
import 'local_store.dart';

const String _storeKey = 'community_comments';

abstract class CommunityCommentRepository {
  Future<List<CommunityComment>> getByPostId(String postId);
  Future<CommunityComment> addComment({
    required String postId,
    required String authorId,
    required String content,
  });
}

class InMemoryCommunityCommentRepository implements CommunityCommentRepository {
  InMemoryCommunityCommentRepository()
    : _comments =
          LocalStore.readList(
            _storeKey,
          )?.map(CommunityComment.fromJson).toList() ??
          [];

  final List<CommunityComment> _comments;
  final Uuid _uuid = const Uuid();

  void _persist() => LocalStore.writeList(
    _storeKey,
    _comments.map((c) => c.toJson()).toList(),
  );

  @override
  Future<List<CommunityComment>> getByPostId(String postId) async {
    return _comments.where((c) => c.postId == postId).toList()
      ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
  }

  @override
  Future<CommunityComment> addComment({
    required String postId,
    required String authorId,
    required String content,
  }) async {
    final comment = CommunityComment(
      id: _uuid.v4(),
      postId: postId,
      authorId: authorId,
      content: content,
      createdAt: DateTime.now(),
    );
    _comments.add(comment);
    _persist();
    return comment;
  }
}
