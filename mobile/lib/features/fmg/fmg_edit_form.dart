import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import '../../shared/fmg/fmg_management.dart';
import '../../shared/theme/theme.dart';
import 'fmg_ui_labels.dart';

/// A mobile edit field whose options are supplied by the owning runtime.
class FmgEditField {
  const FmgEditField(
    this.id,
    this.label, {
    this.multiline = false,
    this.numeric = false,
    this.options,
    this.required = false,
    this.help,
    this.resets = const [],
  });
  final String id;
  final String label;
  final bool multiline;
  final bool numeric;
  final bool required;
  final String? help;
  final Map<String, String>? options;
  final List<String> resets;
}

/// Persists scoped drafts before mutation, preserves failed edits and never loses drafts on Back.
class FmgEditForm extends HookConsumerWidget {
  const FmgEditForm({
    super.key,
    required this.management,
    required this.draftId,
    required this.title,
    required this.fields,
    required this.initial,
    required this.onSave,
  });
  final FmgManagement management;
  final String draftId;
  final String title;
  final List<FmgEditField> fields;
  final Map<String, dynamic> initial;
  final Future<Map<String, dynamic>> Function(Map<String, dynamic>) onSave;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final currentManagement = ref.watch(fmgManagementProvider);
    final controllers = useMemoized(
      () => {
        for (final field in fields)
          field.id: TextEditingController(
            text: initial[field.id]?.toString() ?? '',
          ),
      },
      [draftId],
    );
    final saving = useState(false);
    final loaded = useState(false);
    final error = useState<String?>(null);
    final allowPop = useState(false);
    final changed = useState(0);
    final draftTimer = useRef<Timer?>(null);
    final baseRevision = useRef(initial['_baseRevision']);
    Map<String, dynamic> values() => {
      if (baseRevision.value != null) '_baseRevision': baseRevision.value,
      for (final field in fields)
        field.id: field.numeric
            ? int.tryParse(controllers[field.id]!.text)
            : controllers[field.id]!.text,
    };
    Future<void> store() => management.saveDraft(draftId, values());
    useEffect(() {
      var active = true;
      unawaited(
        management
            .draft(draftId)
            .then((draft) {
              if (!active || !context.mounted) return;
              if (draft != null) {
                baseRevision.value =
                    draft['_baseRevision'] ?? baseRevision.value;
                for (final field in fields) {
                  if (draft.containsKey(field.id)) {
                    controllers[field.id]!.text =
                        draft[field.id]?.toString() ?? '';
                  }
                }
              }
              loaded.value = true;
            })
            .catchError((Object reason) {
              if (active && context.mounted) {
                error.value = fmgDisplayError(reason);
                loaded.value = true;
              }
            }),
      );
      void listen() {
        if (!loaded.value) return;
        changed.value++;
        draftTimer.value?.cancel();
        draftTimer.value = Timer(const Duration(milliseconds: 400), () {
          unawaited(
            store().catchError((Object reason) {
              if (active && context.mounted) {
                error.value = fmgDisplayError(reason);
              }
            }),
          );
        });
      }

      for (final controller in controllers.values) {
        controller.addListener(listen);
      }
      return () {
        active = false;
        draftTimer.value?.cancel();
        for (final controller in controllers.values) {
          controller.removeListener(listen);
          controller.dispose();
        }
      };
    }, [management, draftId]);
    if (currentManagement?.rpc.scope != management.rpc.scope) {
      return Scaffold(
        appBar: AppBar(title: Text(title)),
        body: const Center(child: Text('계정이나 커뮤니티가 변경됐습니다. 이 편집 화면을 닫으세요.')),
      );
    }
    Future<void> back() async {
      if (saving.value) return;
      try {
        draftTimer.value?.cancel();
        await store();
        if (context.mounted) {
          allowPop.value = true;
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (context.mounted) Navigator.of(context).pop();
          });
        }
      } catch (reason) {
        if (context.mounted) error.value = fmgDisplayError(reason);
      }
    }

    Future<void> save() async {
      if (saving.value) return;
      if (fields.any(
        (f) => f.required && controllers[f.id]!.text.trim().isEmpty,
      )) {
        error.value = '필수 항목을 입력하세요.';
        return;
      }
      saving.value = true;
      error.value = null;
      draftTimer.value?.cancel();
      try {
        await store();
        final result = await onSave(values());
        await management.saveDraft(draftId, null);
        management.rpc.assertActive();
        if (context.mounted) {
          allowPop.value = true;
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (context.mounted) Navigator.of(context).pop(result);
          });
        }
      } catch (reason) {
        if (context.mounted) error.value = fmgDisplayError(reason);
      } finally {
        if (context.mounted) saving.value = false;
      }
    }

    return PopScope(
      canPop: allowPop.value,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) unawaited(back());
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(title),
          leading: IconButton(
            onPressed: saving.value ? null : back,
            icon: const Icon(Icons.arrow_back),
          ),
        ),
        body: loaded.value
            ? ListView(
                padding: const EdgeInsets.all(Grid.gutter),
                children: [
                  const Text(
                    '변경은 연결된 PC의 실제 설정과 FMG 커뮤니티에 저장됩니다. 입력 중인 초안은 이 기기에 암호화해 보관합니다.',
                  ),
                  const SizedBox(height: Grid.sm),
                  for (final field in fields) ...[
                    if (field.options != null)
                      DropdownButtonFormField<String>(
                        key: ValueKey(
                          '${field.id}:${controllers[field.id]!.text}',
                        ),
                        initialValue:
                            field.options!.containsKey(
                              controllers[field.id]!.text,
                            )
                            ? controllers[field.id]!.text
                            : null,
                        isExpanded: true,
                        decoration: InputDecoration(
                          labelText: field.label,
                          helperText: field.help,
                        ),
                        items: [
                          for (final entry in field.options!.entries)
                            DropdownMenuItem(
                              value: entry.key,
                              child: Text(
                                entry.value,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                        ],
                        onChanged: saving.value
                            ? null
                            : (value) {
                                controllers[field.id]!.text = value ?? '';
                                for (final dependent in field.resets) {
                                  controllers[dependent]?.text = '';
                                }
                              },
                      )
                    else
                      TextField(
                        controller: controllers[field.id],
                        enabled: !saving.value,
                        minLines: field.multiline ? 4 : 1,
                        maxLines: field.multiline ? 12 : 1,
                        keyboardType: field.numeric
                            ? TextInputType.number
                            : field.multiline
                            ? TextInputType.multiline
                            : TextInputType.text,
                        decoration: InputDecoration(
                          labelText:
                              '${field.label}${field.required ? ' *' : ''}',
                          helperText: field.help,
                        ),
                      ),
                    const SizedBox(height: Grid.sm),
                  ],
                  if (error.value != null)
                    Text(
                      error.value!,
                      style: TextStyle(color: context.colors.error),
                    ),
                  const SizedBox(height: Grid.sm),
                  FilledButton(
                    onPressed: saving.value ? null : save,
                    child: Text(saving.value ? '처리 중…' : '저장'),
                  ),
                  const SizedBox(height: 80),
                ],
              )
            : const Center(child: CircularProgressIndicator()),
      ),
    );
  }
}
