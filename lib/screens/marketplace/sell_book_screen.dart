import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/book.dart';
import '../../models/marketplace_listing.dart';
import '../../providers/library_provider.dart';
import '../../providers/marketplace_provider.dart';
import '../../theme/spacing.dart';
import '../../widgets/common/book_cover_block.dart';

class SellBookScreen extends StatefulWidget {
  const SellBookScreen({super.key, this.preselectedBookId});

  final String? preselectedBookId;

  @override
  State<SellBookScreen> createState() => _SellBookScreenState();
}

class _SellBookScreenState extends State<SellBookScreen> {
  final _formKey = GlobalKey<FormState>();
  final TextEditingController _priceController = TextEditingController();
  final TextEditingController _descriptionController = TextEditingController();
  final TextEditingController _bookSearchController = TextEditingController();

  Book? _selectedBook;
  BookCondition _condition = BookCondition.veryGood;
  List<Book> _bookOptions = const [];
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    if (widget.preselectedBookId != null) {
      _selectedBook = context.read<LibraryProvider>().getBookById(widget.preselectedBookId!);
    }
  }

  @override
  void dispose() {
    _priceController.dispose();
    _descriptionController.dispose();
    _bookSearchController.dispose();
    super.dispose();
  }

  Future<void> _onBookSearchChanged(String value) async {
    final results = await context.read<LibraryProvider>().search(value);
    if (!mounted) return;
    setState(() => _bookOptions = results);
  }

  Future<void> _submit() async {
    if (_selectedBook == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('請先選擇要上架的書籍')),
      );
      return;
    }
    if (!(_formKey.currentState?.validate() ?? false)) return;

    final price = double.tryParse(_priceController.text.trim());
    if (price == null) return;

    setState(() => _submitting = true);
    await context.read<MarketplaceProvider>().addListing(
          bookId: _selectedBook!.id,
          condition: _condition,
          price: price,
          description: _descriptionController.text.trim(),
        );
    if (!mounted) return;

    final messenger = ScaffoldMessenger.of(context);
    Navigator.pop(context);
    messenger.showSnackBar(const SnackBar(content: Text('上架成功！')));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('上架賣書')),
      body: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Form(
          key: _formKey,
          child: ListView(
            children: [
              Text('選擇書籍', style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: AppSpacing.sm),
              if (_selectedBook != null)
                _SelectedBookPreview(
                  book: _selectedBook!,
                  onChange: () => setState(() => _selectedBook = null),
                )
              else
                _BookPicker(
                  controller: _bookSearchController,
                  options: _bookOptions,
                  onChanged: _onBookSearchChanged,
                  onSelect: (book) => setState(() => _selectedBook = book),
                ),
              const SizedBox(height: AppSpacing.lg),
              Text('書況', style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: AppSpacing.sm),
              Wrap(
                spacing: AppSpacing.sm,
                children: [
                  for (final condition in BookCondition.values)
                    ChoiceChip(
                      label: Text(condition.label),
                      selected: _condition == condition,
                      onSelected: (_) => setState(() => _condition = condition),
                    ),
                ],
              ),
              const SizedBox(height: AppSpacing.lg),
              Text('價格 (NT\$)', style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: AppSpacing.sm),
              TextFormField(
                controller: _priceController,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(hintText: '例如：220'),
                validator: (value) {
                  final trimmed = value?.trim() ?? '';
                  if (trimmed.isEmpty) return '請輸入價格';
                  final parsed = double.tryParse(trimmed);
                  if (parsed == null || parsed <= 0) return '請輸入有效的價格';
                  return null;
                },
              ),
              const SizedBox(height: AppSpacing.lg),
              Text('說明', style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: AppSpacing.sm),
              TextFormField(
                controller: _descriptionController,
                maxLines: 4,
                decoration: const InputDecoration(hintText: '描述書況、附贈品等資訊'),
                validator: (value) => (value == null || value.trim().isEmpty) ? '請輸入說明' : null,
              ),
              const SizedBox(height: AppSpacing.xl),
              ElevatedButton(
                onPressed: _submitting ? null : _submit,
                child: Text(_submitting ? '上架中…' : '確認上架'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SelectedBookPreview extends StatelessWidget {
  const _SelectedBookPreview({required this.book, required this.onChange});

  final Book book;
  final VoidCallback onChange;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: Row(
          children: [
            BookCoverBlock(
              title: book.title,
              author: book.author,
              colorIndex: book.coverColorIndex,
              width: 56,
              height: 78,
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(book.title, style: Theme.of(context).textTheme.titleSmall),
                  const SizedBox(height: 2),
                  Text(book.author, style: Theme.of(context).textTheme.bodySmall),
                ],
              ),
            ),
            TextButton(onPressed: onChange, child: const Text('換一本')),
          ],
        ),
      ),
    );
  }
}

class _BookPicker extends StatelessWidget {
  const _BookPicker({
    required this.controller,
    required this.options,
    required this.onChanged,
    required this.onSelect,
  });

  final TextEditingController controller;
  final List<Book> options;
  final ValueChanged<String> onChanged;
  final ValueChanged<Book> onSelect;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextField(
          controller: controller,
          onChanged: onChanged,
          decoration: InputDecoration(
            hintText: '搜尋書名、作者或 ISBN',
            prefixIcon: const Icon(Icons.search),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(AppRadius.buttonRadius),
              borderSide: BorderSide.none,
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.sm),
        if (options.isNotEmpty)
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 260),
            child: ListView.builder(
              shrinkWrap: true,
              itemCount: options.length,
              itemBuilder: (context, index) {
                final book = options[index];
                return ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: BookCoverBlock(
                    title: book.title,
                    colorIndex: book.coverColorIndex,
                    width: 40,
                    height: 56,
                  ),
                  title: Text(book.title, style: Theme.of(context).textTheme.titleSmall),
                  subtitle: Text(book.author, style: Theme.of(context).textTheme.bodySmall),
                  onTap: () => onSelect(book),
                );
              },
            ),
          )
        else
          Text(
            controller.text.trim().isEmpty ? '輸入關鍵字搜尋要上架的書' : '找不到符合的書籍',
            style: Theme.of(context).textTheme.bodySmall,
          ),
      ],
    );
  }
}
