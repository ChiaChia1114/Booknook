// Basic smoke test for the 書窩 Booknook app shell.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:booknook/main.dart';

void main() {
  testWidgets('first launch shows onboarding before the home tab', (WidgetTester tester) async {
    await tester.pumpWidget(const BooknookApp());
    await tester.pumpAndSettle();

    expect(find.text('歡迎來到書窩 Booknook'), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);
  });

  testWidgets('App renders home tab with bottom navigation after skipping onboarding', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const BooknookApp());
    await tester.pumpAndSettle();

    await tester.tap(find.text('跳過'));
    await tester.pumpAndSettle();

    expect(find.text('書窩 Booknook'), findsOneWidget);
    expect(find.byType(NavigationBar), findsOneWidget);
  });
}
