import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../theme/colors.dart';
import '../../theme/spacing.dart';

class BookCoverBlock extends StatelessWidget {
  const BookCoverBlock({
    super.key,
    required this.title,
    this.author,
    required this.colorIndex,
    this.width = 120,
    this.height = 168,
  });

  final String title;
  final String? author;
  final int colorIndex;
  final double width;
  final double height;

  @override
  Widget build(BuildContext context) {
    final Color base = AppColors.bookCoverColor(colorIndex);
    final bool compact = height < 90;
    final int seed = title.hashCode;

    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AppRadius.cardRadius),
        boxShadow: const [
          BoxShadow(
            color: Color(0x1A000000),
            blurRadius: 6,
            offset: Offset(0, 2),
          ),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadius.cardRadius),
        child: Stack(
          fit: StackFit.expand,
          children: [
            DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [_shade(base, 0.14), base, _shade(base, -0.16)],
                ),
              ),
            ),
            Positioned.fill(
              child: CustomPaint(painter: _CoverPatternPainter(seed: seed)),
            ),
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.sm),
                child: ClipRect(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.end,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        maxLines: compact ? 1 : 3,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleSmall?.copyWith(
                          color: Colors.white,
                          fontWeight: FontWeight.w700,
                          shadows: const [
                            Shadow(color: Color(0x59000000), blurRadius: 4),
                          ],
                        ),
                      ),
                      if (!compact && author != null && author!.isNotEmpty) ...[
                        const SizedBox(height: 2),
                        Text(
                          author!,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.labelSmall
                              ?.copyWith(
                                color: Colors.white.withValues(alpha: 0.88),
                                shadows: const [
                                  Shadow(
                                    color: Color(0x59000000),
                                    blurRadius: 3,
                                  ),
                                ],
                              ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Color _shade(Color color, double amount) {
    final hsl = HSLColor.fromColor(color);
    final lightness = (hsl.lightness + amount).clamp(0.0, 1.0);
    return hsl.withLightness(lightness).toColor();
  }
}

class _CoverPatternPainter extends CustomPainter {
  const _CoverPatternPainter({required this.seed});

  final int seed;

  @override
  void paint(Canvas canvas, Size size) {
    final random = math.Random(seed);
    final variant = seed.abs() % 4;
    final paint = Paint()
      ..color = Colors.white.withValues(alpha: 0.12)
      ..style = PaintingStyle.fill;
    final strokePaint = Paint()
      ..color = Colors.white.withValues(alpha: 0.14)
      ..style = PaintingStyle.stroke
      ..strokeWidth = math.max(1.0, size.width * 0.01);

    switch (variant) {
      case 0:
        _drawDiagonalStripes(canvas, size, strokePaint);
      case 1:
        _drawDotGrid(canvas, size, paint);
      case 2:
        _drawConcentricArcs(canvas, size, strokePaint);
      default:
        _drawBlob(canvas, size, paint, random);
    }
  }

  void _drawDiagonalStripes(Canvas canvas, Size size, Paint paint) {
    final spacing = size.width * 0.16;
    final count = ((size.width + size.height) / spacing).ceil();
    for (var i = -count; i < count; i++) {
      final x = i * spacing;
      canvas.drawLine(
        Offset(x, 0),
        Offset(x + size.height, size.height),
        paint,
      );
    }
  }

  void _drawDotGrid(Canvas canvas, Size size, Paint paint) {
    final spacing = size.width * 0.22;
    final radius = size.width * 0.02;
    for (double y = spacing / 2; y < size.height; y += spacing) {
      for (double x = spacing / 2; x < size.width; x += spacing) {
        canvas.drawCircle(Offset(x, y), radius, paint);
      }
    }
  }

  void _drawConcentricArcs(Canvas canvas, Size size, Paint paint) {
    final center = Offset(size.width * 1.05, -size.height * 0.05);
    for (var i = 1; i <= 4; i++) {
      canvas.drawCircle(center, size.width * 0.32 * i, paint);
    }
  }

  void _drawBlob(Canvas canvas, Size size, Paint paint, math.Random random) {
    final path = Path();
    final baseY = size.height * (0.72 + random.nextDouble() * 0.08);
    path.moveTo(0, size.height);
    path.lineTo(0, baseY);
    path.quadraticBezierTo(
      size.width * 0.3,
      baseY - size.height * 0.12,
      size.width * 0.55,
      baseY,
    );
    path.quadraticBezierTo(
      size.width * 0.8,
      baseY + size.height * 0.1,
      size.width,
      baseY - size.height * 0.04,
    );
    path.lineTo(size.width, size.height);
    path.close();
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(covariant _CoverPatternPainter oldDelegate) =>
      oldDelegate.seed != seed;
}
