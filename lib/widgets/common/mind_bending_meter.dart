import 'package:flutter/material.dart';

import '_icon_meter.dart';

class MindBendingMeter extends StatelessWidget {
  const MindBendingMeter({
    super.key,
    required this.value,
    this.max = 5,
    this.iconSize = 18,
    this.showLabel = true,
  });

  final double value;
  final double max;
  final double iconSize;
  final bool showLabel;

  static const List<IconData> _icons = <IconData>[
    Icons.psychology,
    Icons.bolt,
  ];

  @override
  Widget build(BuildContext context) {
    return IconMeterRow(
      value: value,
      max: max,
      icons: _icons,
      filledColor: const Color(0xFF5B6B7A),
      iconSize: iconSize,
      showLabel: showLabel,
    );
  }
}
