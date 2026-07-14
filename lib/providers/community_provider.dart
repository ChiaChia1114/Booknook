import 'package:flutter/foundation.dart';

import '../data/community_post_repository.dart';
import '../data/mock_seed_data.dart';
import '../models/community_post.dart';

class CommunityProvider extends ChangeNotifier {
  CommunityProvider(this._repository) {
    _load();
  }

  final CommunityPostRepository _repository;

  bool isLoading = true;
  List<CommunityPost> posts = [];

  Future<void> _load() async {
    isLoading = true;
    notifyListeners();
    posts = await _repository.getAll();
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
    final post = await _repository.addPost(
      bookId: bookId,
      authorId: currentUserId,
      title: title,
      excerpt: excerpt,
    );
    posts = [post, ...posts];
    notifyListeners();
  }
}
