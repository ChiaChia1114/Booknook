import '../models/user.dart';
import 'mock_seed_data.dart';

abstract class UserRepository {
  Future<List<User>> getAll();
  Future<User?> getById(String id);
  Future<User?> getCurrentUser();
  Future<User> updateUser(User user);
}

class InMemoryUserRepository implements UserRepository {
  final List<User> _users = List.of(seedUsers);

  @override
  Future<List<User>> getAll() async => List.unmodifiable(_users);

  @override
  Future<User?> getById(String id) async {
    for (final user in _users) {
      if (user.id == id) return user;
    }
    return null;
  }

  @override
  Future<User?> getCurrentUser() async => getById(currentUserId);

  @override
  Future<User> updateUser(User user) async {
    final index = _users.indexWhere((u) => u.id == user.id);
    if (index == -1) throw ArgumentError('User ${user.id} not found');
    _users[index] = user;
    return user;
  }
}
