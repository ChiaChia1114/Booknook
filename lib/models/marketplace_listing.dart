enum BookCondition { likeNew, veryGood, good, fair }

extension BookConditionLabel on BookCondition {
  String get label {
    switch (this) {
      case BookCondition.likeNew:
        return '近全新';
      case BookCondition.veryGood:
        return '九成新';
      case BookCondition.good:
        return '八成新';
      case BookCondition.fair:
        return '良好';
    }
  }
}

enum ListingStatus { available, sold }

class MarketplaceListing {
  final String id;
  final String bookId;
  final String sellerId;
  final BookCondition condition;
  final double price;
  final String description;
  final bool isFavorited;
  final DateTime createdAt;
  final ListingStatus status;

  const MarketplaceListing({
    required this.id,
    required this.bookId,
    required this.sellerId,
    required this.condition,
    required this.price,
    required this.description,
    required this.isFavorited,
    required this.createdAt,
    required this.status,
  });

  MarketplaceListing copyWith({
    BookCondition? condition,
    double? price,
    String? description,
    bool? isFavorited,
    ListingStatus? status,
  }) {
    return MarketplaceListing(
      id: id,
      bookId: bookId,
      sellerId: sellerId,
      condition: condition ?? this.condition,
      price: price ?? this.price,
      description: description ?? this.description,
      isFavorited: isFavorited ?? this.isFavorited,
      createdAt: createdAt,
      status: status ?? this.status,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'bookId': bookId,
        'sellerId': sellerId,
        'condition': condition.name,
        'price': price,
        'description': description,
        'isFavorited': isFavorited,
        'createdAt': createdAt.toIso8601String(),
        'status': status.name,
      };

  factory MarketplaceListing.fromJson(Map<String, dynamic> json) => MarketplaceListing(
        id: json['id'] as String,
        bookId: json['bookId'] as String,
        sellerId: json['sellerId'] as String,
        condition: BookCondition.values.byName(json['condition'] as String),
        price: (json['price'] as num).toDouble(),
        description: json['description'] as String,
        isFavorited: json['isFavorited'] as bool,
        createdAt: DateTime.parse(json['createdAt'] as String),
        status: ListingStatus.values.byName(json['status'] as String),
      );
}
