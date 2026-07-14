import '../models/book.dart';
import 'mock_seed_data.dart';

abstract class BookRepository {
  Future<List<Book>> getAll();
  Future<Book?> getById(String id);
  Future<List<Book>> search(String query);
  Future<List<String>> getGenres();
}

class InMemoryBookRepository implements BookRepository {
  final List<Book> _books = List.of(seedBooks);

  @override
  Future<List<Book>> getAll() async => List.unmodifiable(_books);

  @override
  Future<Book?> getById(String id) async {
    for (final book in _books) {
      if (book.id == id) return book;
    }
    return null;
  }

  @override
  Future<List<Book>> search(String query) async {
    final normalized = query.trim().toLowerCase();
    if (normalized.isEmpty) return List.unmodifiable(_books);
    return _books.where((book) {
      return book.title.toLowerCase().contains(normalized) ||
          book.author.toLowerCase().contains(normalized) ||
          book.isbn.contains(normalized);
    }).toList();
  }

  @override
  Future<List<String>> getGenres() async {
    return _books.map((b) => b.genre).toSet().toList();
  }
}
