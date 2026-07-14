// Basic smoke test for the 書窩 Booknook app shell.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:booknook/main.dart';

void main() {
  testWidgets('App renders home tab with bottom navigation', (WidgetTester tester) async {
    await tester.pumpWidget(const BooknookApp());
    await tester.pumpAndSettle();

    expect(find.text('書窩 Booknook'), findsOneWidget);
    expect(find.byType(NavigationBar), findsOneWidget);
  });
}
