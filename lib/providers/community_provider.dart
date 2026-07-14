import 'package:flutter/foundation.dart';

import '../data/community_comment_repository.dart';
import '../data/community_post_repository.dart';
import '../data/mock_seed_data.dart';
import '../models/community_comment.dart';
import '../models/community_post.dart';

class CommunityProvider extends ChangeNotifier {
  CommunityProvider(this._postRepository, this._commentRepository) {
    _load();
  }

  final CommunityPostRepository _postRepository;
  final CommunityCommentRepository _commentRepository;

  bool isLoading = true;
  List<CommunityPost> posts = [];

  Future<void> _load() async {
    isLoading = true;
    notifyListeners();
    posts = await _postRepository.getAll();
    isLoading = false;
    notifyListeners();
  }

  List<CommunityPost> postsForBook(String bookId) {
    return posts.where((p) => p.bookId == bookId).toList();
  }

  Future<void> addPost({
    String? bookId,
    required String title,
    required String excerpt,
  }) async {
    final post = await _postRepository.addPost(
      bookId: bookId,
      authorId: currentUserId,
      title: title,
      excerpt: excerpt,
    );
    posts = [post, ...posts];
    notifyListeners();
  }

  Future<List<CommunityComment>> commentsForPost(String postId) {
    return _commentRepository.getByPostId(postId);
  }

  Future<CommunityComment> addComment({
    required String postId,
    required String content,
  }) async {
    final comment = await _commentRepository.addComment(
      postId: postId,
      authorId: currentUserId,
      content: content,
    );
    final updatedPost = await _postRepository.incrementReplyCount(postId);
    final index = posts.indexWhere((p) => p.id == postId);
    if (index != -1) posts[index] = updatedPost;
    notifyListeners();
    return comment;
  }
}
