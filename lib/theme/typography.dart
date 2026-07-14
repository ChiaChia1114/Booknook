import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'colors.dart';

class AppTypography {
  AppTypography._();

  static TextTheme get textTheme => textThemeFor(AppColors.tokensFor(Brightness.light));

  static TextTheme textThemeFor(AppColorTokens tokens) => TextTheme(
        displaySmall: GoogleFonts.notoSerifTc(
          fontSize: 32,
          fontWeight: FontWeight.w700,
          color: tokens.textPrimary,
          height: 1.3,
        ),
        headlineMedium: GoogleFonts.notoSerifTc(
          fontSize: 24,
          fontWeight: FontWeight.w700,
          color: tokens.textPrimary,
          height: 1.3,
        ),
        headlineSmall: GoogleFonts.notoSerifTc(
          fontSize: 20,
          fontWeight: FontWeight.w600,
          color: tokens.textPrimary,
          height: 1.35,
        ),
        titleLarge: GoogleFonts.notoSerifTc(
          fontSize: 18,
          fontWeight: FontWeight.w600,
          color: tokens.textPrimary,
          height: 1.4,
        ),
        titleMedium: GoogleFonts.notoSansTc(
          fontSize: 16,
          fontWeight: FontWeight.w600,
          color: tokens.textPrimary,
          height: 1.4,
        ),
        titleSmall: GoogleFonts.notoSansTc(
          fontSize: 14,
          fontWeight: FontWeight.w600,
          color: tokens.textPrimary,
          height: 1.4,
        ),
        bodyLarge: GoogleFonts.notoSansTc(
          fontSize: 16,
          fontWeight: FontWeight.w400,
          color: tokens.textPrimary,
          height: 1.5,
        ),
        bodyMedium: GoogleFonts.notoSansTc(
          fontSize: 14,
          fontWeight: FontWeight.w400,
          color: tokens.textPrimary,
          height: 1.5,
        ),
        bodySmall: GoogleFonts.notoSansTc(
          fontSize: 12,
          fontWeight: FontWeight.w400,
          color: tokens.textSecondary,
          height: 1.4,
        ),
        labelLarge: GoogleFonts.notoSansTc(
          fontSize: 14,
          fontWeight: FontWeight.w600,
          color: tokens.textPrimary,
          height: 1.3,
        ),
        labelMedium: GoogleFonts.notoSansTc(
          fontSize: 12,
          fontWeight: FontWeight.w600,
          color: tokens.textSecondary,
          height: 1.3,
        ),
        labelSmall: GoogleFonts.notoSansTc(
          fontSize: 11,
          fontWeight: FontWeight.w500,
          color: tokens.textSecondary,
          height: 1.3,
        ),
      );
}
