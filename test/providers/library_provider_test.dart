// Unit tests for LibraryProvider using the real in-memory repositories.
// No mocking framework needed -- InMemory*Repository already gives us
// deterministic, isolated state per test (each test constructs its own
// provider/repository instances).

import 'package:flutter_test/flutter_test.dart';

import 'package:booknook/data/book_repository.dart';
import 'package:booknook/data/reading_record_repository.dart';
import 'package:booknook/data/review_repository.dart';
import 'package:booknook/models/reading_record.dart';
import 'package:booknook/models/review.dart';
import 'package:booknook/providers/library_provider.dart';

/// Builds a [LibraryProvider] backed by fresh in-memory repositories and
/// waits for its initial async `_load()` to finish so `books` /
/// `myReadingRecords` are populated before assertions run.
Future<LibraryProvider> _createLoadedProvider() async {
  final provider = LibraryProvider(
    InMemoryBookRepository(),
    InMemoryReadingRecordRepository(),
    InMemoryReviewRepository(),
  );
  var attempts = 0;
  while (provider.isLoading && attempts < 50) {
    await Future<void>.delayed(Duration.zero);
    attempts++;
  }
  expect(provider.isLoading, isFalse, reason: 'provider failed to finish loading seed data');
  return provider;
}

void main() {
  group('LibraryProvider.setReadingStatus', () {
    test('updates the status (and timestamps) of an existing record in place', () async {
      final provider = await _createLoadedProvider();

      final existing = provider.recordForBook('book-04');
      expect(existing, isNotNull);
      expect(existing!.status, ReadingStatus.wantToRead);
      expect(existing.startedAt, isNull);

      await provider.setReadingStatus('book-04', ReadingStatus.reading);

      final updated = provider.recordForBook('book-04');
      expect(updated, isNotNull);
      expect(updated!.status, ReadingStatus.reading);
      expect(updated.startedAt, isNotNull);
      // The record was updated in place, not duplicated.
      expect(
        provider.myReadingRecords.where((r) => r.bookId == 'book-04').length,
        1,
      );
    });

    test('adds a brand-new record when the book has no record yet', () async {
      final provider = await _createLoadedProvider();

      expect(provider.recordForBook('book-02'), isNull);
      final beforeCount = provider.myReadingRecords.length;

      await provider.setReadingStatus('book-02', ReadingStatus.wantToRead);

      expect(provider.myReadingRecords.length, beforeCount + 1);
      final record = provider.recordForBook('book-02');
      expect(record, isNotNull);
      expect(record!.status, ReadingStatus.wantToRead);
    });
  });

  group('LibraryProvider.addReview + ratingSummaryForBook', () {
    test('recalculates averages and recommend percent after a new review', () async {
      final provider = await _createLoadedProvider();

      // book-06 seeds with exactly one review (review-10): healing 3.5,
      // mindBending 1.0, tag worthReading (counts toward "recommend").
      final before = await provider.ratingSummaryForBook('book-06');
      expect(before.reviewCount, 1);
      expect(before.averageHealingLevel, closeTo(3.5, 0.001));
      expect(before.averageMindBendingLevel, closeTo(1.0, 0.001));
      expect(before.recommendPercent, 100);

      await provider.addReview(
        bookId: 'book-06',
        healingLevel: 5.0,
        mindBendingLevel: 0.0,
        recommendTag: RecommendTag.mustRead,
        note: '這本書真的很不錯，值得推薦。',
      );

      final afterTwo = await provider.ratingSummaryForBook('book-06');
      expect(afterTwo.reviewCount, 2);
      expect(afterTwo.averageHealingLevel, closeTo((3.5 + 5.0) / 2, 0.001));
      expect(afterTwo.averageMindBendingLevel, closeTo((1.0 + 0.0) / 2, 0.001));
      expect(afterTwo.recommendPercent, 100);

      // Adding a "mixedFeelings" review should pull the recommend percent down.
      await provider.addReview(
        bookId: 'book-06',
        healingLevel: 1.0,
        mindBendingLevel: 4.0,
        recommendTag: RecommendTag.mixedFeelings,
        note: '普普通通，見仁見智。',
      );

      final afterThree = await provider.ratingSummaryForBook('book-06');
      expect(afterThree.reviewCount, 3);
      expect(afterThree.recommendPercent, ((2 / 3) * 100).round());
    });
  });

  group('LibraryProvider.markReviewHelpful', () {
    test('increments the helpfulCount of the targeted review only', () async {
      final provider = await _createLoadedProvider();

      final before = await provider.reviewsForBook('book-01');
      final targetBefore = before.firstWhere((r) => r.id == 'review-01');
      final otherBefore = before.firstWhere((r) => r.id == 'review-02');
      expect(targetBefore.helpfulCount, 32);

      await provider.markReviewHelpful('review-01');

      final after = await provider.reviewsForBook('book-01');
      final targetAfter = after.firstWhere((r) => r.id == 'review-01');
      final otherAfter = after.firstWhere((r) => r.id == 'review-02');
      expect(targetAfter.helpfulCount, 33);
      // Untouched review should be unaffected.
      expect(otherAfter.helpfulCount, otherBefore.helpfulCount);
    });
  });
}
