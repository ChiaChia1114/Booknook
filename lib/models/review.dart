enum RecommendTag { mustRead, worthReading, mixedFeelings }

extension RecommendTagLabel on RecommendTag {
  String get label {
    switch (this) {
      case RecommendTag.mustRead:
        return '一定要看';
      case RecommendTag.worthReading:
        return '值得一讀';
      case RecommendTag.mixedFeelings:
        return '見仁見智';
    }
  }
}

class Review {
  final String id;
  final String bookId;
  final String userId;
  final double healingLevel;
  final double mindBendingLevel;
  final RecommendTag recommendTag;
  final String note;
  final int helpfulCount;
  final DateTime createdAt;

  const Review({
    required this.id,
    required this.bookId,
    required this.userId,
    required this.healingLevel,
    required this.mindBendingLevel,
    required this.recommendTag,
    required this.note,
    required this.helpfulCount,
    required this.createdAt,
  });

  Review copyWith({
    double? healingLevel,
    double? mindBendingLevel,
    RecommendTag? recommendTag,
    String? note,
    int? helpfulCount,
  }) {
    return Review(
      id: id,
      bookId: bookId,
      userId: userId,
      healingLevel: healingLevel ?? this.healingLevel,
      mindBendingLevel: mindBendingLevel ?? this.mindBendingLevel,
      recommendTag: recommendTag ?? this.recommendTag,
      note: note ?? this.note,
      helpfulCount: helpfulCount ?? this.helpfulCount,
      createdAt: createdAt,
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'bookId': bookId,
    'userId': userId,
    'healingLevel': healingLevel,
    'mindBendingLevel': mindBendingLevel,
    'recommendTag': recommendTag.name,
    'note': note,
    'helpfulCount': helpfulCount,
    'createdAt': createdAt.toIso8601String(),
  };

  factory Review.fromJson(Map<String, dynamic> json) => Review(
    id: json['id'] as String,
    bookId: json['bookId'] as String,
    userId: json['userId'] as String,
    healingLevel: (json['healingLevel'] as num).toDouble(),
    mindBendingLevel: (json['mindBendingLevel'] as num).toDouble(),
    recommendTag: RecommendTag.values.byName(json['recommendTag'] as String),
    note: json['note'] as String,
    helpfulCount: json['helpfulCount'] as int,
    createdAt: DateTime.parse(json['createdAt'] as String),
  );
}

class BookRatingSummary {
  final double averageHealingLevel;
  final double averageMindBendingLevel;
  final int recommendPercent;
  final int reviewCount;

  const BookRatingSummary({
    required this.averageHealingLevel,
    required this.averageMindBendingLevel,
    required this.recommendPercent,
    required this.reviewCount,
  });

  static const empty = BookRatingSummary(
    averageHealingLevel: 0,
    averageMindBendingLevel: 0,
    recommendPercent: 0,
    reviewCount: 0,
  );

  factory BookRatingSummary.fromReviews(List<Review> reviews) {
    if (reviews.isEmpty) return empty;
    final healingSum = reviews.fold<double>(
      0,
      (sum, r) => sum + r.healingLevel,
    );
    final mindBendingSum = reviews.fold<double>(
      0,
      (sum, r) => sum + r.mindBendingLevel,
    );
    final recommendCount = reviews
        .where((r) => r.recommendTag != RecommendTag.mixedFeelings)
        .length;
    return BookRatingSummary(
      averageHealingLevel: healingSum / reviews.length,
      averageMindBendingLevel: mindBendingSum / reviews.length,
      recommendPercent: ((recommendCount / reviews.length) * 100).round(),
      reviewCount: reviews.length,
    );
  }
}
