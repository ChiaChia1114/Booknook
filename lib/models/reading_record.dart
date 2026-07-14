enum ReadingStatus { wantToRead, reading, finished }

extension ReadingStatusLabel on ReadingStatus {
  String get label {
    switch (this) {
      case ReadingStatus.wantToRead:
        return '想讀';
      case ReadingStatus.reading:
        return '在讀';
      case ReadingStatus.finished:
        return '讀過';
    }
  }
}

class ReadingRecord {
  final String id;
  final String userId;
  final String bookId;
  final ReadingStatus status;
  final DateTime? startedAt;
  final DateTime? finishedAt;

  const ReadingRecord({
    required this.id,
    required this.userId,
    required this.bookId,
    required this.status,
    this.startedAt,
    this.finishedAt,
  });

  ReadingRecord copyWith({
    ReadingStatus? status,
    DateTime? startedAt,
    DateTime? finishedAt,
  }) {
    return ReadingRecord(
      id: id,
      userId: userId,
      bookId: bookId,
      status: status ?? this.status,
      startedAt: startedAt ?? this.startedAt,
      finishedAt: finishedAt ?? this.finishedAt,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'userId': userId,
        'bookId': bookId,
        'status': status.name,
        'startedAt': startedAt?.toIso8601String(),
        'finishedAt': finishedAt?.toIso8601String(),
      };

  factory ReadingRecord.fromJson(Map<String, dynamic> json) => ReadingRecord(
        id: json['id'] as String,
        userId: json['userId'] as String,
        bookId: json['bookId'] as String,
        status: ReadingStatus.values.byName(json['status'] as String),
        startedAt: json['startedAt'] == null ? null : DateTime.parse(json['startedAt'] as String),
        finishedAt: json['finishedAt'] == null ? null : DateTime.parse(json['finishedAt'] as String),
      );
}
