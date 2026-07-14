import 'package:flutter/foundation.dart';

import '../data/user_repository.dart';
import '../models/user.dart';

class UserProvider extends ChangeNotifier {
  UserProvider(this._repository) {
    _load();
  }

  final UserRepository _repository;

  bool isLoading = true;
  User? currentUser;
  List<User> allUsers = [];

  Future<void> _load() async {
    isLoading = true;
    notifyListeners();
    final users = await _repository.getAll();
    currentUser = await _repository.getCurrentUser();
    allUsers = users;
    isLoading = false;
    notifyListeners();
  }

  User? getById(String id) {
    for (final user in allUsers) {
      if (user.id == id) return user;
    }
    return null;
  }

  Future<void> updateBio(String bio) async {
    final user = currentUser;
    if (user == null) return;
    final updated = await _repository.updateUser(user.copyWith(bio: bio));
    currentUser = updated;
    final index = allUsers.indexWhere((u) => u.id == updated.id);
    if (index != -1) allUsers[index] = updated;
    notifyListeners();
  }
}
