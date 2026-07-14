class CommunityPost {
  final String id;
  final String? bookId;
  final String authorId;
  final String title;
  final int replyCount;
  final DateTime lastActiveAt;
  final String excerpt;

  const CommunityPost({
    required this.id,
    this.bookId,
    required this.authorId,
    required this.title,
    required this.replyCount,
    required this.lastActiveAt,
    required this.excerpt,
  });

  CommunityPost copyWith({
    int? replyCount,
    DateTime? lastActiveAt,
    String? excerpt,
  }) {
    return CommunityPost(
      id: id,
      bookId: bookId,
      authorId: authorId,
      title: title,
      replyCount: replyCount ?? this.replyCount,
      lastActiveAt: lastActiveAt ?? this.lastActiveAt,
      excerpt: excerpt ?? this.excerpt,
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'bookId': bookId,
    'authorId': authorId,
    'title': title,
    'replyCount': replyCount,
    'lastActiveAt': lastActiveAt.toIso8601String(),
    'excerpt': excerpt,
  };

  factory CommunityPost.fromJson(Map<String, dynamic> json) => CommunityPost(
    id: json['id'] as String,
    bookId: json['bookId'] as String?,
    authorId: json['authorId'] as String,
    title: json['title'] as String,
    replyCount: json['replyCount'] as int,
    lastActiveAt: DateTime.parse(json['lastActiveAt'] as String),
    excerpt: json['excerpt'] as String,
  );
}
