import 'package:flutter/material.dart';

import '../../data/local_store.dart';
import '../../theme/colors.dart';
import '../../theme/spacing.dart';
import '../../widgets/common/mascot_badge.dart';

const String _onboardingSeenKey = 'has_seen_onboarding';

class _OnboardingSlide {
  const _OnboardingSlide({
    required this.icon,
    required this.title,
    required this.description,
  });

  final IconData icon;
  final String title;
  final String description;
}

const List<_OnboardingSlide> _slides = [
  _OnboardingSlide(
    icon: Icons.menu_book_outlined,
    title: '歡迎來到書窩 Booknook',
    description: '蠹蠹在這裡陪你記錄每一段閱讀時光，這裡是專屬於愛書人的安靜角落。',
  ),
  _OnboardingSlide(
    icon: Icons.favorite_border,
    title: '用療癒與燒腦程度評分',
    description: '不只是星等，用「療癒程度」與「燒腦程度」記下這本書帶給你的真實感受。',
  ),
  _OnboardingSlide(
    icon: Icons.forum_outlined,
    title: '在社群分享與討論',
    description: '看看書友們在讀什麼、留言交流心得，或發起一個新的話題。',
  ),
  _OnboardingSlide(
    icon: Icons.storefront_outlined,
    title: '二手書市集，讓好書循環',
    description: '把讀過不需要的書上架，也能挖到別人割愛的好書，價格實惠又環保。',
  ),
];

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key, required this.onDone});

  final VoidCallback onDone;

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();

  static Future<bool> hasSeenOnboarding() async {
    return LocalStore.readString(_onboardingSeenKey) == 'true';
  }
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  final PageController _controller = PageController();
  int _index = 0;

  void _finish() {
    LocalStore.writeString(_onboardingSeenKey, 'true');
    widget.onDone();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isLast = _index == _slides.length - 1;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Align(
              alignment: Alignment.topRight,
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.md),
                child: TextButton(onPressed: _finish, child: const Text('跳過')),
              ),
            ),
            Expanded(
              child: PageView.builder(
                controller: _controller,
                itemCount: _slides.length,
                onPageChanged: (i) => setState(() => _index = i),
                itemBuilder: (context, i) {
                  final slide = _slides[i];
                  return Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.lg,
                    ),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        if (i == 0)
                          const MascotBadge(size: 96)
                        else
                          Container(
                            width: 96,
                            height: 96,
                            decoration: BoxDecoration(
                              color: AppColors.accentLight,
                              shape: BoxShape.circle,
                            ),
                            child: Icon(
                              slide.icon,
                              size: 44,
                              color: AppColors.accentDark,
                            ),
                          ),
                        const SizedBox(height: AppSpacing.lg),
                        Text(
                          slide.title,
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.headlineSmall,
                        ),
                        const SizedBox(height: AppSpacing.sm),
                        Text(
                          slide.description,
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.bodyLarge,
                        ),
                      ],
                    ),
                  );
                },
              ),
            ),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                for (var i = 0; i < _slides.length; i++)
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 200),
                    margin: const EdgeInsets.symmetric(horizontal: 4),
                    width: i == _index ? 20 : 6,
                    height: 6,
                    decoration: BoxDecoration(
                      color: i == _index ? AppColors.accent : AppColors.border,
                      borderRadius: BorderRadius.circular(AppRadius.chipRadius),
                    ),
                  ),
              ],
            ),
            Padding(
              padding: const EdgeInsets.all(AppSpacing.lg),
              child: SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: isLast
                      ? _finish
                      : () => _controller.nextPage(
                          duration: const Duration(milliseconds: 260),
                          curve: Curves.easeOutCubic,
                        ),
                  child: Text(isLast ? '開始探索' : '下一步'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
