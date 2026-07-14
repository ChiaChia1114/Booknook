import 'package:flutter/material.dart';

import '../data/local_store.dart';

const String _storeKey = 'theme_mode';

class ThemeModeProvider extends ChangeNotifier {
  ThemeModeProvider() : mode = _readInitialMode();

  ThemeMode mode;

  static ThemeMode _readInitialMode() {
    final stored = LocalStore.readString(_storeKey);
    return stored == 'dark' ? ThemeMode.dark : ThemeMode.light;
  }

  bool get isDark => mode == ThemeMode.dark;

  void toggle() {
    mode = isDark ? ThemeMode.light : ThemeMode.dark;
    LocalStore.writeString(_storeKey, isDark ? 'dark' : 'light');
    notifyListeners();
  }
}
