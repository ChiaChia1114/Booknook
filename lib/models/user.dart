class User {
  final String id;
  final String name;
  final int avatarColorIndex;
  final String bio;
  final int booksReadCount;
  final int listingsCount;

  const User({
    required this.id,
    required this.name,
    required this.avatarColorIndex,
    required this.bio,
    required this.booksReadCount,
    required this.listingsCount,
  });

  User copyWith({
    String? name,
    int? avatarColorIndex,
    String? bio,
    int? booksReadCount,
    int? listingsCount,
  }) {
    return User(
      id: id,
      name: name ?? this.name,
      avatarColorIndex: avatarColorIndex ?? this.avatarColorIndex,
      bio: bio ?? this.bio,
      booksReadCount: booksReadCount ?? this.booksReadCount,
      listingsCount: listingsCount ?? this.listingsCount,
    );
  }
}
