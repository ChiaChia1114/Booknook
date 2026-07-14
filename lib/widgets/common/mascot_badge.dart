import 'package:flutter/material.dart';

import '../../theme/colors.dart';

class MascotBadge extends StatelessWidget {
  const MascotBadge({super.key, this.size = 40});

  final double size;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: SizedBox(
        width: size,
        height: size,
        child: CustomPaint(painter: _MascotPainter()),
      ),
    );
  }
}

class _MascotPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final Offset center = Offset(size.width / 2, size.height / 2);
    final double r = size.width / 2;

    final Paint bodyPaint = Paint()..color = AppColors.accent;
    final Paint bellyPaint = Paint()..color = AppColors.accentLight;
    final Paint darkPaint = Paint()..color = AppColors.textPrimary;

    canvas.drawCircle(center, r, bodyPaint);
    canvas.drawOval(
      Rect.fromCenter(
        center: center + Offset(0, r * 0.18),
        width: r * 1.15,
        height: r * 1.0,
      ),
      bellyPaint,
    );

    final double eyeOffsetX = r * 0.32;
    final double eyeOffsetY = -r * 0.15;
    final double eyeR = r * 0.11;
    canvas.drawCircle(
      center + Offset(-eyeOffsetX, eyeOffsetY),
      eyeR,
      darkPaint,
    );
    canvas.drawCircle(center + Offset(eyeOffsetX, eyeOffsetY), eyeR, darkPaint);

    final double antennaLen = r * 0.55;
    final Paint antennaPaint = Paint()
      ..color = AppColors.textPrimary
      ..strokeWidth = size.width * 0.035
      ..strokeCap = StrokeCap.round;

    final Offset leftBase = center + Offset(-r * 0.28, -r * 0.75);
    final Offset leftTip =
        leftBase + Offset(-antennaLen * 0.5, -antennaLen * 0.7);
    canvas.drawLine(leftBase, leftTip, antennaPaint);
    canvas.drawCircle(leftTip, r * 0.08, bodyPaint);

    final Offset rightBase = center + Offset(r * 0.28, -r * 0.75);
    final Offset rightTip =
        rightBase + Offset(antennaLen * 0.5, -antennaLen * 0.7);
    canvas.drawLine(rightBase, rightTip, antennaPaint);
    canvas.drawCircle(rightTip, r * 0.08, bodyPaint);

    final Paint mouthPaint = Paint()
      ..color = AppColors.textPrimary
      ..style = PaintingStyle.stroke
      ..strokeWidth = size.width * 0.03
      ..strokeCap = StrokeCap.round;
    final Rect mouthRect = Rect.fromCenter(
      center: center + Offset(0, r * 0.15),
      width: r * 0.5,
      height: r * 0.4,
    );
    canvas.drawArc(mouthRect, 0.2, 2.7, false, mouthPaint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
