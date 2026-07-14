import 'package:uuid/uuid.dart';

import '../models/marketplace_listing.dart';
import 'mock_seed_data.dart';

abstract class MarketplaceListingRepository {
  Future<List<MarketplaceListing>> getAll();
  Future<List<MarketplaceListing>> getByBookId(String bookId);
  Future<List<MarketplaceListing>> getBySellerId(String sellerId);
  Future<MarketplaceListing> addListing({
    required String bookId,
    required String sellerId,
    required BookCondition condition,
    required double price,
    required String description,
  });
  Future<MarketplaceListing> toggleFavorite(String listingId);
  Future<MarketplaceListing> markSold(String listingId);
}

class InMemoryMarketplaceListingRepository implements MarketplaceListingRepository {
  final List<MarketplaceListing> _listings = List.of(seedMarketplaceListings);
  final Uuid _uuid = const Uuid();

  @override
  Future<List<MarketplaceListing>> getAll() async {
    return List.of(_listings)..sort((a, b) => b.createdAt.compareTo(a.createdAt));
  }

  @override
  Future<List<MarketplaceListing>> getByBookId(String bookId) async {
    return _listings.where((l) => l.bookId == bookId).toList();
  }

  @override
  Future<List<MarketplaceListing>> getBySellerId(String sellerId) async {
    return _listings.where((l) => l.sellerId == sellerId).toList();
  }

  @override
  Future<MarketplaceListing> addListing({
    required String bookId,
    required String sellerId,
    required BookCondition condition,
    required double price,
    required String description,
  }) async {
    final listing = MarketplaceListing(
      id: _uuid.v4(),
      bookId: bookId,
      sellerId: sellerId,
      condition: condition,
      price: price,
      description: description,
      isFavorited: false,
      createdAt: DateTime.now(),
      status: ListingStatus.available,
    );
    _listings.add(listing);
    return listing;
  }

  @override
  Future<MarketplaceListing> toggleFavorite(String listingId) async {
    final index = _listings.indexWhere((l) => l.id == listingId);
    if (index == -1) throw ArgumentError('Listing $listingId not found');
    final updated = _listings[index].copyWith(
      isFavorited: !_listings[index].isFavorited,
    );
    _listings[index] = updated;
    return updated;
  }

  @override
  Future<MarketplaceListing> markSold(String listingId) async {
    final index = _listings.indexWhere((l) => l.id == listingId);
    if (index == -1) throw ArgumentError('Listing $listingId not found');
    final updated = _listings[index].copyWith(status: ListingStatus.sold);
    _listings[index] = updated;
    return updated;
  }
}
