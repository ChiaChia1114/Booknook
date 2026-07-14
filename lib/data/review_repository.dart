import 'package:uuid/uuid.dart';

import '../models/review.dart';
import 'mock_seed_data.dart';

abstract class ReviewRepository {
  Future<List<Review>> getByBookId(String bookId);
  Future<List<Review>> getByUserId(String userId);
  Future<BookRatingSummary> getSummaryForBook(String bookId);
  Future<Review> addReview({
    required String bookId,
    required String userId,
    required double healingLevel,
    required double mindBendingLevel,
    required RecommendTag recommendTag,
    required String note,
  });
  Future<Review> markHelpful(String reviewId);
}

class InMemoryReviewRepository implements ReviewRepository {
  final List<Review> _reviews = List.of(seedReviews);
  final Uuid _uuid = const Uuid();

  @override
  Future<List<Review>> getByBookId(String bookId) async {
    return _reviews.where((r) => r.bookId == bookId).toList()
      ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
  }

  @override
  Future<List<Review>> getByUserId(String userId) async {
    return _reviews.where((r) => r.userId == userId).toList()
      ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
  }

  @override
  Future<BookRatingSummary> getSummaryForBook(String bookId) async {
    final reviews = await getByBookId(bookId);
    return BookRatingSummary.fromReviews(reviews);
  }

  @override
  Future<Review> addReview({
    required String bookId,
    required String userId,
    required double healingLevel,
    required double mindBendingLevel,
    required RecommendTag recommendTag,
    required String note,
  }) async {
    final review = Review(
      id: _uuid.v4(),
      bookId: bookId,
      userId: userId,
      healingLevel: healingLevel,
      mindBendingLevel: mindBendingLevel,
      recommendTag: recommendTag,
      note: note,
      helpfulCount: 0,
      createdAt: DateTime.now(),
    );
    _reviews.add(review);
    return review;
  }

  @override
  Future<Review> markHelpful(String reviewId) async {
    final index = _reviews.indexWhere((r) => r.id == reviewId);
    if (index == -1) throw ArgumentError('Review $reviewId not found');
    final updated = _reviews[index].copyWith(
      helpfulCount: _reviews[index].helpfulCount + 1,
    );
    _reviews[index] = updated;
    return updated;
  }
}
