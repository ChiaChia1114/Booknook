import 'package:flutter/foundation.dart';

import '../data/marketplace_listing_repository.dart';
import '../data/mock_seed_data.dart';
import '../models/marketplace_listing.dart';

class MarketplaceProvider extends ChangeNotifier {
  MarketplaceProvider(this._repository) {
    _load();
  }

  final MarketplaceListingRepository _repository;

  bool isLoading = true;
  List<MarketplaceListing> listings = [];

  Future<void> _load() async {
    isLoading = true;
    notifyListeners();
    listings = await _repository.getAll();
    isLoading = false;
    notifyListeners();
  }

  List<MarketplaceListing> get availableListings =>
      listings.where((l) => l.status == ListingStatus.available).toList();

  List<MarketplaceListing> listingsForBook(String bookId) {
    return listings.where((l) => l.bookId == bookId).toList();
  }

  List<MarketplaceListing> get myListings =>
      listings.where((l) => l.sellerId == currentUserId).toList();

  Future<void> addListing({
    required String bookId,
    required BookCondition condition,
    required double price,
    required String description,
  }) async {
    final listing = await _repository.addListing(
      bookId: bookId,
      sellerId: currentUserId,
      condition: condition,
      price: price,
      description: description,
    );
    listings = [listing, ...listings];
    notifyListeners();
  }

  Future<void> toggleFavorite(String listingId) async {
    final updated = await _repository.toggleFavorite(listingId);
    _replace(updated);
  }

  Future<void> markSold(String listingId) async {
    final updated = await _repository.markSold(listingId);
    _replace(updated);
  }

  void _replace(MarketplaceListing updated) {
    final index = listings.indexWhere((l) => l.id == updated.id);
    if (index != -1) listings[index] = updated;
    notifyListeners();
  }
}
