import 'package:flutter/material.dart';

import '../../theme/colors.dart';

class UserAvatar extends StatelessWidget {
  const UserAvatar({
    super.key,
    required this.name,
    required this.avatarColorIndex,
    this.radius = 16,
    this.fontSize,
  });

  final String name;
  final int avatarColorIndex;
  final double radius;
  final double? fontSize;

  @override
  Widget build(BuildContext context) {
    return CircleAvatar(
      radius: radius,
      backgroundColor: AppColors.bookCoverColor(avatarColorIndex),
      child: Text(
        name.isNotEmpty ? name.substring(0, 1) : '?',
        style: TextStyle(
          color: Colors.white,
          fontWeight: FontWeight.w700,
          fontSize: fontSize ?? radius * 0.8,
        ),
      ),
    );
  }
}
