import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

class LocalStore {
  LocalStore._();

  static SharedPreferences? _prefs;

  static Future<void> init() async {
    _prefs ??= await SharedPreferences.getInstance();
  }

  static List<Map<String, dynamic>>? readList(String key) {
    final raw = _prefs?.getString(key);
    if (raw == null) return null;
    return (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
  }

  static void writeList(String key, List<Map<String, dynamic>> value) {
    _prefs?.setString(key, jsonEncode(value));
  }

  static String? readString(String key) => _prefs?.getString(key);

  static void writeString(String key, String value) {
    _prefs?.setString(key, value);
  }
}
