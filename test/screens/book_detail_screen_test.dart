// Widget tests for BookDetailScreen, wired up with the real in-memory
// repositories/providers (no mocking framework needed).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:booknook/data/book_repository.dart';
import 'package:booknook/data/marketplace_listing_repository.dart';
import 'package:booknook/data/reading_record_repository.dart';
import 'package:booknook/data/review_repository.dart';
import 'package:booknook/data/user_repository.dart';
import 'package:booknook/providers/library_provider.dart';
import 'package:booknook/providers/marketplace_provider.dart';
import 'package:booknook/providers/user_provider.dart';
import 'package:booknook/screens/book_detail/book_detail_screen.dart';

/// book-06 (情緒排毒：與焦慮和平共處) is not in the current user's reading
/// records and has exactly one seeded review, which makes it a convenient
/// fixture for asserting on both the "加入想讀" toggle and review-count changes.
const String _testBookId = 'book-06';

Widget _buildApp({String bookId = _testBookId}) {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider(create: (_) => UserProvider(InMemoryUserRepository())),
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
    child: MaterialApp(
      home: BookDetailScreen(bookId: bookId),
    ),
  );
}

void main() {
  // BookDetailScreen's body is a ListView (lazily-built sliver). With the
  // default ~600px test surface, content below the fold (description,
  // review list, etc.) never gets built/mounted, so finders can't see it.
  // Growing the test surface lets the whole page lay out in a single pass.
  void useTallSurface(WidgetTester tester) {
    tester.view.physicalSize = const Size(800, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
  }

  testWidgets('renders rating summary block and review count', (tester) async {
    useTallSurface(tester);
    await tester.pumpWidget(_buildApp());
    await tester.pumpAndSettle();

    // The title legitimately appears more than once: AppBar, page heading,
    // and the watermark rendered inside BookCoverBlock's cover artwork.
    expect(find.text('情緒排毒：與焦慮和平共處'), findsWidgets);
    expect(find.text('社群平均評價'), findsOneWidget);
    expect(find.text('讀者評價（1）'), findsOneWidget);
  });

  testWidgets('tapping "加入想讀" flips it to "已加入想讀"', (tester) async {
    useTallSurface(tester);
    await tester.pumpWidget(_buildApp());
    await tester.pumpAndSettle();

    expect(find.text('加入想讀'), findsOneWidget);
    expect(find.text('已加入想讀'), findsNothing);

    await tester.tap(find.text('加入想讀'));
    await tester.pumpAndSettle();

    expect(find.text('已加入想讀'), findsOneWidget);
    expect(find.text('加入想讀'), findsNothing);
  });

  testWidgets('submitting the review sheet increases the review count', (tester) async {
    useTallSurface(tester);
    await tester.pumpWidget(_buildApp());
    await tester.pumpAndSettle();

    expect(find.text('讀者評價（1）'), findsOneWidget);

    await tester.tap(find.text('寫下你的評價'));
    await tester.pumpAndSettle();

    // Bottom sheet title reuses the same label as the trigger button.
    expect(find.text('寫下你的評價'), findsWidgets);
    expect(find.byType(TextField), findsOneWidget);

    const noteText = '這本書真的很不錯，值得推薦。';
    await tester.enterText(find.byType(TextField), noteText);
    await tester.tap(find.text('送出評價'));
    await tester.pumpAndSettle();

    expect(find.text('讀者評價（2）'), findsOneWidget);
    expect(find.text(noteText), findsOneWidget);
  });
}
