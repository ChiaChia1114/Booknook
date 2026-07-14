import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/reading_record.dart';
import '../../providers/library_provider.dart';
import '../../providers/marketplace_provider.dart';
import '../../providers/theme_mode_provider.dart';
import '../../providers/user_provider.dart';
import '../../theme/colors.dart';
import '../../theme/spacing.dart';
import '../../widgets/common/user_avatar.dart';
import '../library/my_library_screen.dart';
import '../marketplace/marketplace_screen.dart';
import 'achievements_screen.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final userProvider = context.watch<UserProvider>();
    final libraryProvider = context.watch<LibraryProvider>();
    final marketplaceProvider = context.watch<MarketplaceProvider>();
    final themeModeProvider = context.watch<ThemeModeProvider>();
    final user = userProvider.currentUser;

    return Scaffold(
      appBar: AppBar(title: const Text('我的')),
      body: user == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(AppSpacing.md),
              children: [
                Row(
                  children: [
                    UserAvatar(
                      name: user.name,
                      avatarColorIndex: user.avatarColorIndex,
                      radius: 36,
                      fontSize: 24,
                    ),
                    const SizedBox(width: AppSpacing.md),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(user.name, style: Theme.of(context).textTheme.headlineSmall),
                          const SizedBox(height: 4),
                          Text(user.bio, style: Theme.of(context).textTheme.bodyMedium),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.lg),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
                    child: Row(
                      children: [
                        _StatItem(
                          label: '讀過',
                          value: '${libraryProvider.recordsByStatus(ReadingStatus.finished).length}',
                        ),
                        const _StatDivider(),
                        _StatItem(
                          label: '上架',
                          value: '${marketplaceProvider.myListings.length}',
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: AppSpacing.lg),
                Card(
                  child: SwitchListTile(
                    secondary: Icon(themeModeProvider.isDark ? Icons.dark_mode : Icons.light_mode_outlined),
                    title: const Text('深色模式'),
                    value: themeModeProvider.isDark,
                    onChanged: (_) => themeModeProvider.toggle(),
                  ),
                ),
                const SizedBox(height: AppSpacing.lg),
                Card(
                  child: Column(
                    children: [
                      ListTile(
                        leading: const Icon(Icons.menu_book_outlined),
                        title: const Text('我的書櫃'),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () => Navigator.push(
                          context,
                          MaterialPageRoute(builder: (_) => const MyLibraryScreen()),
                        ),
                      ),
                      const Divider(height: 1),
                      ListTile(
                        leading: const Icon(Icons.storefront_outlined),
                        title: const Text('我上架的商品'),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () => Navigator.push(
                          context,
                          MaterialPageRoute(builder: (_) => const MarketplaceScreen(onlyMine: true)),
                        ),
                      ),
                      const Divider(height: 1),
                      ListTile(
                        leading: const Icon(Icons.emoji_events_outlined),
                        title: const Text('我的成就'),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () => Navigator.push(
                          context,
                          MaterialPageRoute(builder: (_) => const AchievementsScreen()),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
    );
  }
}

class _StatItem extends StatelessWidget {
  const _StatItem({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Column(
        children: [
          Text(value, style: Theme.of(context).textTheme.headlineSmall?.copyWith(color: AppColors.accentDark)),
          const SizedBox(height: 4),
          Text(label, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}

class _StatDivider extends StatelessWidget {
  const _StatDivider();

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 32,
      child: VerticalDivider(width: 1, color: AppColors.border),
    );
  }
}
