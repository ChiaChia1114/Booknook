import 'package:flutter/material.dart';

import '../../theme/colors.dart';
import '../../theme/spacing.dart';

class RecommendBar extends StatelessWidget {
  const RecommendBar({
    super.key,
    required this.percent,
    this.height = 8,
    this.showLabel = true,
  });

  final double percent;
  final double height;
  final bool showLabel;

  @override
  Widget build(BuildContext context) {
    final double clamped = percent.clamp(0, 100).toDouble();
    return Row(
      children: [
        Expanded(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(AppRadius.chipRadius),
            child: LinearProgressIndicator(
              value: clamped / 100,
              minHeight: height,
              backgroundColor: AppColors.surfaceSubtle,
              valueColor: const AlwaysStoppedAnimation<Color>(AppColors.accent),
            ),
          ),
        ),
        if (showLabel) ...[
          const SizedBox(width: AppSpacing.sm),
          Text(
            '${clamped.toStringAsFixed(0)}%',
            style: Theme.of(context)
                .textTheme
                .labelLarge
                ?.copyWith(color: AppColors.accentDark),
          ),
        ],
      ],
    );
  }
}
