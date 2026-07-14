import 'package:flutter/material.dart';

class AppColorTokens {
  const AppColorTokens({
    required this.background,
    required this.surface,
    required this.surfaceSubtle,
    required this.textPrimary,
    required this.textSecondary,
    required this.accent,
    required this.accentLight,
    required this.accentDark,
    required this.success,
    required this.danger,
    required this.border,
    required this.borderStrong,
  });

  final Color background;
  final Color surface;
  final Color surfaceSubtle;
  final Color textPrimary;
  final Color textSecondary;
  final Color accent;
  final Color accentLight;
  final Color accentDark;
  final Color success;
  final Color danger;
  final Color border;
  final Color borderStrong;
}

class AppColors {
  AppColors._();

  static const AppColorTokens _light = AppColorTokens(
    background: Color(0xFFF7F4EE),
    surface: Color(0xFFFFFFFF),
    surfaceSubtle: Color(0xFFF1ECE1),
    textPrimary: Color(0xFF2B2723),
    textSecondary: Color(0xFF6B655C),
    accent: Color(0xFFB8792A),
    accentLight: Color(0xFFEFE0C4),
    accentDark: Color(0xFF8A5A1E),
    success: Color(0xFF6E7455),
    danger: Color(0xFFA8635A),
    border: Color(0xFFE3DCCC),
    borderStrong: Color(0xFFC9BFA8),
  );

  static const AppColorTokens _dark = AppColorTokens(
    background: Color(0xFF1C1A17),
    surface: Color(0xFF262320),
    surfaceSubtle: Color(0xFF302C27),
    textPrimary: Color(0xFFF1ECE3),
    textSecondary: Color(0xFFB8AFA0),
    accent: Color(0xFFDDA45C),
    accentLight: Color(0xFF4A3B22),
    accentDark: Color(0xFFF0C48A),
    success: Color(0xFF9AA37D),
    danger: Color(0xFFCB8A80),
    border: Color(0xFF423C34),
    borderStrong: Color(0xFF5A5245),
  );

  static AppColorTokens tokensFor(Brightness brightness) =>
      brightness == Brightness.dark ? _dark : _light;

  static Brightness _brightness = Brightness.light;
  static AppColorTokens get _current => tokensFor(_brightness);

  static void setBrightness(Brightness brightness) {
    _brightness = brightness;
  }

  static Color get background => _current.background;
  static Color get surface => _current.surface;
  static Color get surfaceSubtle => _current.surfaceSubtle;
  static Color get textPrimary => _current.textPrimary;
  static Color get textSecondary => _current.textSecondary;
  static const Color textOnAccent = Color(0xFFFFFFFF);
  static Color get accent => _current.accent;
  static Color get accentLight => _current.accentLight;
  static Color get accentDark => _current.accentDark;
  static Color get success => _current.success;
  static Color get danger => _current.danger;
  static Color get border => _current.border;
  static Color get borderStrong => _current.borderStrong;

  static const List<Color> bookCoverPalette = <Color>[
    Color(0xFFA8635A),
    Color(0xFF5B6B7A),
    Color(0xFF6E7455),
    Color(0xFFB8792A),
    Color(0xFF3F7D75),
    Color(0xFF7A5B72),
    Color(0xFF4A5A6B),
    Color(0xFF8A6E4B),
  ];

  static Color bookCoverColor(int index) =>
      bookCoverPalette[index % bookCoverPalette.length];
}
