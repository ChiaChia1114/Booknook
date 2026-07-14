import 'package:flutter/foundation.dart';

import '../data/book_repository.dart';
import '../data/mock_seed_data.dart';
import '../data/reading_record_repository.dart';
import '../data/review_repository.dart';
import '../models/book.dart';
import '../models/reading_record.dart';
import '../models/review.dart';

class LibraryProvider extends ChangeNotifier {
  LibraryProvider(
    this._bookRepository,
    this._readingRecordRepository,
    this._reviewRepository,
  ) {
    _load();
  }

  final BookRepository _bookRepository;
  final ReadingRecordRepository _readingRecordRepository;
  final ReviewRepository _reviewRepository;

  bool isLoading = true;
  List<Book> books = [];
  List<ReadingRecord> myReadingRecords = [];

  Future<void> _load() async {
    isLoading = true;
    notifyListeners();
    books = await _bookRepository.getAll();
    myReadingRecords = await _readingRecordRepository.getByUserId(currentUserId);
    isLoading = false;
    notifyListeners();
  }

  Book? getBookById(String id) {
    for (final book in books) {
      if (book.id == id) return book;
    }
    return null;
  }

  Future<List<Book>> search(String query) => _bookRepository.search(query);

  ReadingRecord? recordForBook(String bookId) {
    for (final record in myReadingRecords) {
      if (record.bookId == bookId) return record;
    }
    return null;
  }

  List<ReadingRecord> recordsByStatus(ReadingStatus status) {
    return myReadingRecords.where((r) => r.status == status).toList();
  }

  Future<void> setReadingStatus(String bookId, ReadingStatus status) async {
    final updated = await _readingRecordRepository.setStatus(
      userId: currentUserId,
      bookId: bookId,
      status: status,
    );
    final index = myReadingRecords.indexWhere((r) => r.bookId == bookId);
    if (index == -1) {
      myReadingRecords.add(updated);
    } else {
      myReadingRecords[index] = updated;
    }
    notifyListeners();
  }

  Future<List<Review>> reviewsForBook(String bookId) {
    return _reviewRepository.getByBookId(bookId);
  }

  Future<List<ReadingRecord>> recordsForUser(String userId) {
    return _readingRecordRepository.getByUserId(userId);
  }

  Future<BookRatingSummary> ratingSummaryForBook(String bookId) {
    return _reviewRepository.getSummaryForBook(bookId);
  }

  Future<Review> addReview({
    required String bookId,
    required double healingLevel,
    required double mindBendingLevel,
    required RecommendTag recommendTag,
    required String note,
  }) async {
    final review = await _reviewRepository.addReview(
      bookId: bookId,
      userId: currentUserId,
      healingLevel: healingLevel,
      mindBendingLevel: mindBendingLevel,
      recommendTag: recommendTag,
      note: note,
    );
    notifyListeners();
    return review;
  }

  Future<void> markReviewHelpful(String reviewId) async {
    await _reviewRepository.markHelpful(reviewId);
    notifyListeners();
  }
}
