class Book {
  final String id;
  final String title;
  final String author;
  final int coverColorIndex;
  final String genre;
  final String description;
  final String isbn;

  const Book({
    required this.id,
    required this.title,
    required this.author,
    required this.coverColorIndex,
    required this.genre,
    required this.description,
    required this.isbn,
  });

  Book copyWith({
    String? title,
    String? author,
    int? coverColorIndex,
    String? genre,
    String? description,
    String? isbn,
  }) {
    return Book(
      id: id,
      title: title ?? this.title,
      author: author ?? this.author,
      coverColorIndex: coverColorIndex ?? this.coverColorIndex,
      genre: genre ?? this.genre,
      description: description ?? this.description,
      isbn: isbn ?? this.isbn,
    );
  }
}
