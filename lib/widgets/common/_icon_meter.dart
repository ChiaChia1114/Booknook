import 'package:flutter/material.dart';

import '../../theme/colors.dart';

class IconMeterRow extends StatelessWidget {
  const IconMeterRow({
    super.key,
    required this.value,
    required this.max,
    required this.icons,
    required this.filledColor,
    required this.iconSize,
    required this.showLabel,
  });

  final double value;
  final double max;
  final List<IconData> icons;
  final Color filledColor;
  final double iconSize;
  final bool showLabel;

  @override
  Widget build(BuildContext context) {
    final int count = max.round();
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (int i = 0; i < count; i++)
          Padding(
            padding: EdgeInsets.only(right: i == count - 1 ? 0 : 2),
            child: _MeterIcon(
              icon: icons[i.isEven ? 0 : 1],
              fraction: (value - i).clamp(0, 1).toDouble(),
              size: iconSize,
              filledColor: filledColor,
              emptyColor: AppColors.border,
            ),
          ),
        if (showLabel) ...[
          const SizedBox(width: 6),
          Text(
            '${value.toStringAsFixed(1)}/${max.toStringAsFixed(0)}',
            style: Theme.of(context).textTheme.labelMedium,
          ),
        ],
      ],
    );
  }
}

class _MeterIcon extends StatelessWidget {
  const _MeterIcon({
    required this.icon,
    required this.fraction,
    required this.size,
    required this.filledColor,
    required this.emptyColor,
  });

  final IconData icon;
  final double fraction;
  final double size;
  final Color filledColor;
  final Color emptyColor;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        children: [
          Icon(icon, size: size, color: emptyColor),
          if (fraction > 0)
            ClipRect(
              clipper: _FractionClipper(fraction),
              child: Icon(icon, size: size, color: filledColor),
            ),
        ],
      ),
    );
  }
}

class _FractionClipper extends CustomClipper<Rect> {
  _FractionClipper(this.fraction);

  final double fraction;

  @override
  Rect getClip(Size size) => Rect.fromLTWH(0, 0, size.width * fraction, size.height);

  @override
  bool shouldReclip(covariant _FractionClipper oldClipper) =>
      oldClipper.fraction != fraction;
}
