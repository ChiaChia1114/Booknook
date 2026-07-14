import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'data/book_repository.dart';
import 'data/community_post_repository.dart';
import 'data/local_store.dart';
import 'data/marketplace_listing_repository.dart';
import 'data/reading_record_repository.dart';
import 'data/review_repository.dart';
import 'data/user_repository.dart';
import 'providers/community_provider.dart';
import 'providers/library_provider.dart';
import 'providers/marketplace_provider.dart';
import 'providers/theme_mode_provider.dart';
import 'providers/user_provider.dart';
import 'screens/community/community_screen.dart';
import 'screens/home/home_screen.dart';
import 'screens/library/my_library_screen.dart';
import 'screens/marketplace/marketplace_screen.dart';
import 'screens/profile/profile_screen.dart';
import 'theme/app_theme.dart';
import 'theme/colors.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await LocalStore.init();
  runApp(const BooknookApp());
}

class BooknookApp extends StatelessWidget {
  const BooknookApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => ThemeModeProvider()),
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
        ChangeNotifierProvider(
          create: (_) => CommunityProvider(InMemoryCommunityPostRepository()),
        ),
      ],
      child: Consumer<ThemeModeProvider>(
        builder: (context, themeModeProvider, _) {
          AppColors.setBrightness(themeModeProvider.isDark ? Brightness.dark : Brightness.light);
          return MaterialApp(
            title: '書窩 Booknook',
            debugShowCheckedModeBanner: false,
            theme: AppTheme.lightTheme,
            darkTheme: AppTheme.darkTheme,
            themeMode: themeModeProvider.mode,
            home: const RootShell(),
          );
        },
      ),
    );
  }
}

class RootShell extends StatefulWidget {
  const RootShell({super.key});

  @override
  State<RootShell> createState() => _RootShellState();
}

class _RootShellState extends State<RootShell> {
  int _currentIndex = 0;

  static const List<Widget> _tabs = [
    HomeScreen(),
    CommunityScreen(),
    MyLibraryScreen(),
    MarketplaceScreen(),
    ProfileScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(index: _currentIndex, children: _tabs),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _currentIndex,
        onDestinationSelected: (index) => setState(() => _currentIndex = index),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: '首頁'),
          NavigationDestination(icon: Icon(Icons.forum_outlined), selectedIcon: Icon(Icons.forum), label: '社群'),
          NavigationDestination(icon: Icon(Icons.menu_book_outlined), selectedIcon: Icon(Icons.menu_book), label: '書籍'),
          NavigationDestination(icon: Icon(Icons.storefront_outlined), selectedIcon: Icon(Icons.storefront), label: '市集'),
          NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: '我的'),
        ],
      ),
    );
  }
}
