import 'package:flutter/material.dart';

class AppColors {
  AppColors._();

  static const Color background = Color(0xFFF7F4EE);
  static const Color surface = Color(0xFFFFFFFF);
  static const Color surfaceSubtle = Color(0xFFF1ECE1);

  static const Color textPrimary = Color(0xFF2B2723);
  static const Color textSecondary = Color(0xFF6B655C);
  static const Color textOnAccent = Color(0xFFFFFFFF);

  static const Color accent = Color(0xFFB8792A);
  static const Color accentLight = Color(0xFFEFE0C4);
  static const Color accentDark = Color(0xFF8A5A1E);

  static const Color success = Color(0xFF6E7455);
  static const Color danger = Color(0xFFA8635A);

  static const Color border = Color(0xFFE3DCCC);
  static const Color borderStrong = Color(0xFFC9BFA8);

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
