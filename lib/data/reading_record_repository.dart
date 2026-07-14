import 'package:uuid/uuid.dart';

import '../models/reading_record.dart';
import 'mock_seed_data.dart';

abstract class ReadingRecordRepository {
  Future<List<ReadingRecord>> getByUserId(String userId);
  Future<ReadingRecord?> getForUserAndBook(String userId, String bookId);
  Future<ReadingRecord> setStatus({
    required String userId,
    required String bookId,
    required ReadingStatus status,
  });
}

class InMemoryReadingRecordRepository implements ReadingRecordRepository {
  final List<ReadingRecord> _records = List.of(seedReadingRecords);
  final Uuid _uuid = const Uuid();

  @override
  Future<List<ReadingRecord>> getByUserId(String userId) async {
    return _records.where((r) => r.userId == userId).toList();
  }

  @override
  Future<ReadingRecord?> getForUserAndBook(String userId, String bookId) async {
    for (final record in _records) {
      if (record.userId == userId && record.bookId == bookId) return record;
    }
    return null;
  }

  @override
  Future<ReadingRecord> setStatus({
    required String userId,
    required String bookId,
    required ReadingStatus status,
  }) async {
    final index = _records.indexWhere(
      (r) => r.userId == userId && r.bookId == bookId,
    );
    final now = DateTime.now();
    if (index == -1) {
      final record = ReadingRecord(
        id: _uuid.v4(),
        userId: userId,
        bookId: bookId,
        status: status,
        startedAt: status == ReadingStatus.reading || status == ReadingStatus.finished ? now : null,
        finishedAt: status == ReadingStatus.finished ? now : null,
      );
      _records.add(record);
      return record;
    }
    final existing = _records[index];
    final updated = existing.copyWith(
      status: status,
      startedAt: existing.startedAt ??
          (status == ReadingStatus.reading || status == ReadingStatus.finished ? now : null),
      finishedAt: status == ReadingStatus.finished ? now : existing.finishedAt,
    );
    _records[index] = updated;
    return updated;
  }
}
