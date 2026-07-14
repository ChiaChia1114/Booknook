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
}
