// Unit tests for MarketplaceProvider using the real in-memory repository.

import 'package:flutter_test/flutter_test.dart';

import 'package:booknook/data/marketplace_listing_repository.dart';
import 'package:booknook/data/mock_seed_data.dart';
import 'package:booknook/models/marketplace_listing.dart';
import 'package:booknook/providers/marketplace_provider.dart';

/// Builds a [MarketplaceProvider] backed by a fresh in-memory repository and
/// waits for its initial async `_load()` to finish.
Future<MarketplaceProvider> _createLoadedProvider() async {
  final provider = MarketplaceProvider(InMemoryMarketplaceListingRepository());
  var attempts = 0;
  while (provider.isLoading && attempts < 50) {
    await Future<void>.delayed(Duration.zero);
    attempts++;
  }
  expect(provider.isLoading, isFalse, reason: 'provider failed to finish loading seed data');
  return provider;
}

void main() {
  group('MarketplaceProvider.addListing', () {
    test('adds the new listing to the front of listings for the current user', () async {
      final provider = await _createLoadedProvider();
      final beforeCount = provider.listings.length;

      await provider.addListing(
        bookId: 'book-03',
        condition: BookCondition.good,
        price: 199,
        description: '書況良好，附書衣。',
      );

      expect(provider.listings.length, beforeCount + 1);
      final newListing = provider.listings.first;
      expect(newListing.bookId, 'book-03');
      expect(newListing.sellerId, currentUserId);
      expect(newListing.status, ListingStatus.available);
      expect(newListing.isFavorited, isFalse);
    });
  });

  group('MarketplaceProvider.toggleFavorite', () {
    test('flips isFavorited for the given listing and leaves others untouched', () async {
      final provider = await _createLoadedProvider();
      final before = provider.listings.firstWhere((l) => l.id == 'listing-01');
      expect(before.isFavorited, isFalse);
      final otherBefore = provider.listings.firstWhere((l) => l.id == 'listing-02');
      expect(otherBefore.isFavorited, isTrue);

      await provider.toggleFavorite('listing-01');
      expect(
        provider.listings.firstWhere((l) => l.id == 'listing-01').isFavorited,
        isTrue,
      );
      // Unrelated listing is unaffected.
      expect(
        provider.listings.firstWhere((l) => l.id == 'listing-02').isFavorited,
        isTrue,
      );

      await provider.toggleFavorite('listing-01');
      expect(
        provider.listings.firstWhere((l) => l.id == 'listing-01').isFavorited,
        isFalse,
      );
    });
  });

  group('MarketplaceProvider.myListings', () {
    test('only contains listings whose sellerId is the current user', () async {
      final provider = await _createLoadedProvider();

      final mine = provider.myListings;
      expect(mine.every((l) => l.sellerId == currentUserId), isTrue);
      expect(mine.map((l) => l.id).toSet(), {'listing-06', 'listing-11'});

      await provider.addListing(
        bookId: 'book-07',
        condition: BookCondition.fair,
        price: 99,
        description: '出清價出售。',
      );

      final mineAfter = provider.myListings;
      expect(mineAfter.length, mine.length + 1);
      expect(mineAfter.every((l) => l.sellerId == currentUserId), isTrue);
    });
  });
}
