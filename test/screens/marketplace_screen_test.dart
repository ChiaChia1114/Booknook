// Widget tests for MarketplaceScreen, wired up with the real in-memory
// repositories/providers (no mocking framework needed).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:booknook/data/book_repository.dart';
import 'package:booknook/data/marketplace_listing_repository.dart';
import 'package:booknook/data/reading_record_repository.dart';
import 'package:booknook/data/review_repository.dart';
import 'package:booknook/providers/library_provider.dart';
import 'package:booknook/providers/marketplace_provider.dart';
import 'package:booknook/screens/marketplace/marketplace_screen.dart';

Widget _buildApp() {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider(
        create: (_) => LibraryProvider(
          InMemoryBookRepository(),
          InMemoryReadingRecordRepository(),
          InMemoryReviewRepository(),
        ),
      ),
      ChangeNotifierProvider(
        create: (_) => MarketplaceProvider(InMemoryMarketplaceListingRepository()),
      ),
    ],
    child: const MaterialApp(
      home: MarketplaceScreen(),
    ),
  );
}

void main() {
  testWidgets('selecting a category chip filters the displayed listing count', (tester) async {
    await tester.pumpWidget(_buildApp());
    await tester.pumpAndSettle();

    // 11 seeded listings, 1 of which is sold (excluded from availableListings).
    expect(find.text('共 10 本在售'), findsOneWidget);

    await tester.tap(find.text('文學小說'));
    await tester.pumpAndSettle();

    // Available listings whose book genre is 文學小說: book-01, book-05,
    // book-09, book-13 => 4 listings.
    expect(find.text('共 4 本在售'), findsOneWidget);

    // Switching back to 全部 restores the full count.
    await tester.tap(find.text('全部'));
    await tester.pumpAndSettle();
    expect(find.text('共 10 本在售'), findsOneWidget);
  });

  testWidgets('search text filters listings by book title/author/ISBN', (tester) async {
    await tester.pumpWidget(_buildApp());
    await tester.pumpAndSettle();

    expect(find.text('共 10 本在售'), findsOneWidget);

    // '陳建豪' is the author of book-04, which has exactly one available
    // listing (listing-03).
    await tester.enterText(find.byType(TextField), '陳建豪');
    await tester.pumpAndSettle();

    expect(find.text('共 1 本在售'), findsOneWidget);
    // The title legitimately renders twice per card: once as the watermark
    // inside BookCoverBlock's cover artwork, and once as the label below it.
    expect(find.text('財務自由的第一堂課'), findsNWidgets(2));

    // Clearing the search restores the full list.
    await tester.enterText(find.byType(TextField), '');
    await tester.pumpAndSettle();
    expect(find.text('共 10 本在售'), findsOneWidget);
  });
}
