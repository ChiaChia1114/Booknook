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
    return Container(
      width: width,
      height: height,
      padding: const EdgeInsets.all(AppSpacing.sm),
      decoration: BoxDecoration(
        color: base,
        borderRadius: BorderRadius.circular(AppRadius.cardRadius),
        boxShadow: const [
          BoxShadow(
            color: Color(0x1A000000),
            blurRadius: 6,
            offset: Offset(0, 2),
          ),
        ],
      ),
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
                  ),
            ),
            if (!compact && author != null && author!.isNotEmpty) ...[
              const SizedBox(height: 2),
              Text(
                author!,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: Colors.white.withValues(alpha: 0.85),
                    ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
